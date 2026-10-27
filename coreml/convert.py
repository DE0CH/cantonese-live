"""Qwen3-ASR (1.7B by default) -> CoreML for the Neural Engine, in the layout speech-swift's CoreMLASRModel loads
(the same contracts as aufklarer/Qwen3-ASR-CoreML, the 0.6B export):

  encoder.mlpackage        mel [1,128,3000] f32 + mel_length [1] i32 -> audio_embeddings [1,390,D] f16 + output_length [1] i32
  embedding.mlpackage      token_id [1,1] i32 -> embedding [1,1,H] f16
  decoder_part1.mlpackage  input_embeds [1,T,H] f32, positions [T] i32, attention_mask [1,1,T,MAX] f32 -> hidden_state
  decoder_part2.mlpackage  same inputs (hidden in) -> logits [1,1,V] (last position)
  config.json

Both decoder parts keep their KV caches as CoreML states k_cache_i / v_cache_i [1,KV,MAX,head_dim] f16.

  python convert.py --model /path/to/Qwen3-ASR-1.7B --out out/ [--check clip.wav]

--check runs the exported torch modules (fp32, the exact graphs that get converted) through the whole
transcription loop the Swift runner does and prints the text next to the official qwen_asr output, so a wrong
re-implementation shows before anything is converted.
"""
import argparse
import json
import math
import os

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

T = 128        # tokens per decoder dispatch (config enumerated_t)
MAX = 1024     # KV cache length (config max_seq_length)
MEL = 3000     # fixed mel frames (30 s)
CHUNK = 100    # mel frames per encoder chunk -> 13 tokens
NEG = -1e4     # fp16-safe mask value


def rms_norm(x, weight, eps, dim):
    # LayerNorm over [x, -x] has mean 0 and variance mean(x^2): RMSNorm through the native layer_norm op, which
    # stays in range in fp16 on the Neural Engine where x.pow(2).mean() overflows (Qwen3 has large activations).
    y = F.layer_norm(torch.cat([x, -x], dim=-1), (dim * 2,), eps=eps)
    return y[..., :dim] * weight


# ---------------------------------------------------------------- encoder

class Encoder(nn.Module):
    def __init__(self, tower, cfg):
        super().__init__()
        self.t = tower
        self.heads = cfg.encoder_attention_heads
        self.chunks = MEL // CHUNK
        self.per_chunk = 13
        self.window = self.per_chunk * (cfg.n_window_infer // (cfg.n_window * 2))   # 104 tokens = 8 chunks
        n = self.chunks * self.per_chunk
        idx = torch.arange(n)
        self.register_buffer("same_block", (idx[:, None] // self.window == idx[None, :] // self.window).float())
        self.register_buffer("idx", idx.float())
        self.register_buffer("pos", tower.positional_embedding.positional_embedding[: self.per_chunk].clone())
        # Shapes as constants: values read off traced tensors become ops coremltools can't fold.
        self.d = cfg.d_model
        self.conv_ch = cfg.downsample_hidden_size
        self.conv_f = ((((cfg.num_mel_bins + 1) // 2 + 1) // 2 + 1) // 2)

    def forward(self, mel, mel_length):
        t = self.t
        x = mel[0].reshape(128, self.chunks, CHUNK).permute(1, 0, 2).unsqueeze(1)   # [30,1,128,100]
        x = F.gelu(t.conv2d1(x))
        x = F.gelu(t.conv2d2(x))
        x = F.gelu(t.conv2d3(x))                                                      # [30,480,16,13]
        b, w = self.chunks, self.per_chunk
        x = t.conv_out(x.permute(0, 3, 1, 2).reshape(b, w, self.conv_ch * self.conv_f)) + self.pos   # [30,13,d]
        h = x.reshape(b * w, self.d)                                                   # [390,d]

        # Real token count, as _get_feat_extract_output_lengths (non-negative form: ceil three times).
        L = mel_length.to(torch.int32)
        leave = L % CHUNK
        c1 = (leave + 1) // 2
        c2 = (c1 + 1) // 2
        c3 = (c2 + 1) // 2
        n_real = c3 + (L // CHUNK) * self.per_chunk                                    # [1] int32

        valid = (self.idx[None, :] < n_real.to(torch.float32)[:, None]).float()       # [1,390]
        bias = ((1.0 - self.same_block * valid) * NEG).to(h.dtype)                     # [390,390]

        d = self.d
        hd = d // self.heads
        for layer in t.layers:
            r = h
            y = layer.self_attn_layer_norm(h)
            a = layer.self_attn
            q = a.q_proj(y).reshape(b * w, self.heads, hd).transpose(0, 1)
            k = a.k_proj(y).reshape(b * w, self.heads, hd).transpose(0, 1)
            v = a.v_proj(y).reshape(b * w, self.heads, hd).transpose(0, 1)
            s = torch.matmul(q, k.transpose(1, 2)) * a.scaling + bias
            o = torch.matmul(torch.softmax(s, dim=-1), v).transpose(0, 1).reshape(b * w, d)
            h = r + a.out_proj(o)
            r = h
            y = layer.final_layer_norm(h)
            h = r + layer.fc2(layer.activation_fn(layer.fc1(y)))
        h = t.ln_post(h)
        h = t.proj2(t.act(t.proj1(h)))
        return h.unsqueeze(0), n_real


# ---------------------------------------------------------------- decoder

class Embedding(nn.Module):
    def __init__(self, emb):
        super().__init__()
        self.emb = emb

    def forward(self, token_id):
        return self.emb(token_id)


class DecoderPart(nn.Module):
    def __init__(self, layers, tcfg, final_norm=None, lm_head=None):
        super().__init__()
        self.layers = nn.ModuleList(layers)
        self.heads = tcfg.num_attention_heads
        self.kv = tcfg.num_key_value_heads
        self.hd = tcfg.head_dim
        self.hidden = tcfg.hidden_size
        self.eps = tcfg.rms_norm_eps
        self.final_norm = final_norm
        self.lm_head = lm_head
        inv = 1.0 / (tcfg.rope_theta ** (torch.arange(0, self.hd, 2).float() / self.hd))
        ang = torch.arange(MAX).float()[:, None] * inv[None, :]
        ang = torch.cat([ang, ang], dim=-1)                                            # [MAX,hd]
        self.register_buffer("cos_t", ang.cos())
        self.register_buffer("sin_t", ang.sin())
        self.register_buffer("slots", torch.arange(MAX).float())
        for i in range(len(layers)):
            self.register_buffer(f"k_cache_{i}", torch.zeros(1, self.kv, MAX, self.hd))
            self.register_buffer(f"v_cache_{i}", torch.zeros(1, self.kv, MAX, self.hd))

    def rot(self, x):
        h = self.hd // 2
        return torch.cat([-x[..., h:], x[..., :h]], dim=-1)

    def forward(self, input_embeds, positions, attention_mask):
        # One-hot rows of the slots being written: picks RoPE angles (exact, no fp16 angle math) and scatters the
        # new keys/values into the cache with a matmul.
        onehot = (positions.to(torch.float32)[:, None] == self.slots.float()[None, :]).to(input_embeds.dtype)   # [T,MAX]
        keep = (1.0 - onehot.sum(0))[None, None, :, None]                                # [1,1,MAX,1]
        cos = torch.matmul(onehot, self.cos_t)[None, None]                               # [1,1,T,hd]
        sin = torch.matmul(onehot, self.sin_t)[None, None]
        put = onehot.t()[None, None]                                                     # [1,1,MAX,T]
        rep = self.heads // self.kv
        h = input_embeds
        n = T
        for i, layer in enumerate(self.layers):
            a = layer.self_attn
            r = h
            y = rms_norm(h, layer.input_layernorm.weight, self.eps, self.hidden)
            q = a.q_proj(y).view(1, n, self.heads, self.hd)
            k = a.k_proj(y).view(1, n, self.kv, self.hd)
            v = a.v_proj(y).view(1, n, self.kv, self.hd).transpose(1, 2)
            q = rms_norm(q, a.q_norm.weight, self.eps, self.hd).transpose(1, 2)
            k = rms_norm(k, a.k_norm.weight, self.eps, self.hd).transpose(1, 2)
            q = q * cos + self.rot(q) * sin
            k = k * cos + self.rot(k) * sin
            kc = getattr(self, f"k_cache_{i}")
            vc = getattr(self, f"v_cache_{i}")
            nk = kc * keep + torch.matmul(put, k)
            nv = vc * keep + torch.matmul(put, v)
            kc[:, :, :, :] = nk
            vc[:, :, :, :] = nv
            kk = nk.repeat_interleave(rep, dim=1)
            vv = nv.repeat_interleave(rep, dim=1)
            s = torch.matmul(q, kk.transpose(2, 3)) * a.scaling + attention_mask
            o = torch.matmul(torch.softmax(s, dim=-1), vv).transpose(1, 2).reshape(1, n, self.heads * self.hd)
            h = r + a.o_proj(o)
            r = h
            y = rms_norm(h, layer.post_attention_layernorm.weight, self.eps, self.hidden)
            h = r + layer.mlp(y)
        if self.lm_head is None:
            return h
        h = rms_norm(h[:, -1:, :], self.final_norm.weight, self.eps, self.hidden)
        return self.lm_head(h)


# ---------------------------------------------------------------- load + check

def load(model_dir):
    from qwen_asr.core.transformers_backend import Qwen3ASRForConditionalGeneration
    m = Qwen3ASRForConditionalGeneration.from_pretrained(model_dir, torch_dtype=torch.float32)
    m.eval()
    return m


def build(m):
    th = m.thinker
    acfg = th.config.audio_config
    tcfg = th.config.text_config
    enc = Encoder(th.audio_tower, acfg).eval()
    emb = Embedding(th.model.embed_tokens).eval()
    split = len(th.model.layers) // 2
    p1 = DecoderPart(list(th.model.layers[:split]), tcfg).eval()
    p2 = DecoderPart(list(th.model.layers[split:]), tcfg, th.model.norm, th.lm_head).eval()
    return enc, emb, p1, p2, split


class Runner:
    """The Swift runner's loop (CoreMLTextDecoder/CoreMLASRModel.transcribeWithoutMLX) over the torch modules."""

    IM_START, IM_END, NL, SYSTEM, USER, ASSISTANT = 151644, 151645, 198, 8948, 872, 77091
    AUDIO_START, AUDIO_END, ASR_TEXT = 151669, 151670, 151704

    def __init__(self, emb, p1, p2, dtype=torch.float32):
        self.emb, self.p1, self.p2, self.dtype = emb, p1, p2, dtype
        self.pos = 0
        self.scratch = MAX - (T - 1)
        for p in (p1, p2):
            for name, buf in p.named_buffers():
                if "_cache_" in name:
                    buf.zero_()

    def chunk(self, rows):
        n = rows.shape[0]
        first = T - n
        e = torch.zeros(1, T, rows.shape[1], dtype=self.dtype)
        e[0, first:] = rows
        pos = torch.tensor([self.scratch + i for i in range(first)] + [self.pos + i for i in range(n)], dtype=torch.int32)
        mask = torch.full((1, 1, T, MAX), NEG, dtype=self.dtype)
        for t in range(first, T):
            p = self.pos + t - first
            mask[0, 0, t, : min(p + 1, self.scratch)] = 0
        self.pos += n
        h = self.p1(e, pos, mask)
        return self.p2(h, pos, mask)

    def tokens(self, ids):
        rows = self.emb(torch.tensor([ids]))[0]
        out = None
        for i in range(0, len(ids), T):
            out = self.chunk(rows[i:i + T])
        return out

    def transcribe(self, audio_rows, tokenizer, max_tokens=200):
        with torch.no_grad():
            self.tokens([self.IM_START, self.SYSTEM, self.NL, self.IM_END, self.NL, self.IM_START, self.USER, self.NL, self.AUDIO_START])
            for i in range(0, audio_rows.shape[0], T):
                self.chunk(audio_rows[i:i + T])
            logits = self.tokens([self.AUDIO_END, self.IM_END, self.NL, self.IM_START, self.ASSISTANT, self.NL, self.ASR_TEXT])
            out = []
            for _ in range(max_tokens):
                tok = int(logits[0, -1].argmax())
                if tok in (self.IM_END, 151643):
                    break
                out.append(tok)
                logits = self.tokens([tok])
        return tokenizer.decode(out)


def dump(model_dir, enc, emb, p1, p2, wav, path):
    """Reference tensors for verify.py: the mel, the encoder output, and the logits of the first decoder dispatch."""
    from transformers import AutoProcessor
    proc = AutoProcessor.from_pretrained(model_dir)
    mel, frames, _ = mel_of(wav, proc)
    with torch.no_grad():
        embeds, n = enc(mel, torch.tensor([frames], dtype=torch.int32))
        r = Runner(emb, p1, p2)
        logits = r.tokens([Runner.IM_START, Runner.SYSTEM, Runner.NL])
        audio_logits = None
        for i in range(0, int(n[0]), T):
            audio_logits = r.chunk(embeds[0, i:min(i + T, int(n[0]))])
    np.savez_compressed(path, mel=mel.numpy(), frames=np.int32(frames), embeds=embeds[0, : int(n[0])].numpy(),
                        prefix_logits=logits[0, -1].numpy(), audio_logits=audio_logits[0, -1].numpy())
    print("dumped", path)


def fake_int8(m):
    """Round every big weight the way linear_quantize_weights stores it, to see what int8 costs."""
    for mod in m.modules():
        w = getattr(mod, "weight", None)
        if isinstance(mod, (nn.Linear, nn.Conv2d, nn.Embedding)) and w is not None and w.numel() >= 2048:
            flat = w.data.reshape(w.shape[0], -1)
            scale = flat.abs().amax(dim=1, keepdim=True).clamp(min=1e-12) / 127
            w.data = (torch.round(flat / scale).clamp(-127, 127) * scale).reshape(w.shape)


def mel_of(path, processor):
    import soundfile as sf
    audio, sr = sf.read(path, dtype="float32")
    assert sr == 16000, sr
    feats = processor.feature_extractor(audio, sampling_rate=16000, return_tensors="pt", padding=False,
                                        return_attention_mask=True)
    mel = feats["input_features"][0]                                                  # [128, frames]
    frames = int(feats["attention_mask"][0].sum())
    mel = mel[:, :frames]
    padded = torch.zeros(1, 128, MEL)
    padded[0, :, :frames] = mel
    return padded, frames, audio


def check(model_dir, m, enc, emb, p1, p2, wav, fp16=False):
    from transformers import AutoProcessor
    from qwen_asr import Qwen3ASRModel
    proc = AutoProcessor.from_pretrained(model_dir)
    mel, frames, audio = mel_of(wav, proc)
    if fp16:
        # The Neural Engine computes in fp16: run the same graphs in half precision to catch overflow.
        for mod in (enc, emb, p1, p2):
            mod.half()
        embeds, n = enc(mel.half(), torch.tensor([frames], dtype=torch.int32))
        n = int(n[0])
        print(f"fp16 encoder: {n} tokens, finite: {bool(torch.isfinite(embeds[0, :n]).all())}")
        print("EXPORT fp16:", Runner(emb, p1, p2, torch.float16).transcribe(embeds[0, :n], proc.tokenizer))
        return
    with torch.no_grad():
        embeds, n = enc(mel, torch.tensor([frames], dtype=torch.int32))
        ref = m.thinker.audio_tower(mel[0, :, :frames], feature_lens=torch.tensor([frames])).last_hidden_state
    n = int(n[0])
    print(f"encoder: {n} tokens (reference {ref.shape[0]}), max abs diff {float((embeds[0, :n] - ref).abs().max()):.2e}")
    text = Runner(emb, p1, p2).transcribe(embeds[0, :n], proc.tokenizer)
    print("EXPORT   :", text)
    official = Qwen3ASRModel.from_pretrained(model_dir, dtype=torch.float32, device_map="cpu")
    print("OFFICIAL :", official.transcribe(audio=(audio, 16000))[0].text)


# ---------------------------------------------------------------- convert

def convert(enc, emb, p1, p2, split, tcfg, acfg, out, model_name, only=None, precision="fp16", quantize=True):
    import coremltools as ct
    import coremltools.optimize.coreml as cto

    os.makedirs(out, exist_ok=True)
    prec = ct.precision.FLOAT16 if precision == "fp16" else ct.precision.FLOAT32
    qcfg = cto.OptimizationConfig(global_config=cto.OpLinearQuantizerConfig(mode="linear_symmetric", dtype="int8",
                                                                            granularity="per_channel"))

    def done(name):
        if only and not name.startswith(only):
            return True
        return os.path.exists(os.path.join(out, name))   # re-runs pick up where a killed run stopped

    def save(mlmodel, name):
        if quantize:
            mlmodel = cto.linear_quantize_weights(mlmodel, qcfg)
        mlmodel.save(os.path.join(out, name))
        print("saved", name, flush=True)

    if not done("encoder.mlpackage"):
        with torch.no_grad():
            tr = torch.jit.trace(enc, (torch.zeros(1, 128, MEL), torch.tensor([MEL], dtype=torch.int32)))
        save(ct.convert(tr, inputs=[ct.TensorType("mel", (1, 128, MEL), np.float32),
                                    ct.TensorType("mel_length", (1,), np.int32)],
                        outputs=[ct.TensorType("audio_embeddings", dtype=np.float16),
                                 ct.TensorType("output_length", dtype=np.int32)],
                        minimum_deployment_target=ct.target.iOS18, compute_precision=prec),
             "encoder.mlpackage")

    if not done("embedding.mlpackage"):
        with torch.no_grad():
            tr = torch.jit.trace(emb, (torch.zeros(1, 1, dtype=torch.int32),))
        save(ct.convert(tr, inputs=[ct.TensorType("token_id", (1, 1), np.int32)],
                        outputs=[ct.TensorType("embedding", dtype=np.float16)],
                        minimum_deployment_target=ct.target.iOS18, compute_precision=prec),
             "embedding.mlpackage")

    H = tcfg.hidden_size
    for name, part, out_name in (("decoder_part1", p1, "hidden_state"), ("decoder_part2", p2, "logits")):
        if done(f"{name}.mlpackage"):
            continue
        ex = (torch.zeros(1, T, H), torch.arange(T, dtype=torch.int32), torch.zeros(1, 1, T, MAX))
        with torch.no_grad():
            tr = torch.jit.trace(part, ex)
        states = []
        for i in range(len(part.layers)):
            for kv in ("k", "v"):
                states.append(ct.StateType(ct.TensorType(shape=(1, tcfg.num_key_value_heads, MAX, tcfg.head_dim),
                                                         dtype=np.float16), name=f"{kv}_cache_{i}"))
        save(ct.convert(tr, inputs=[ct.TensorType("input_embeds", (1, T, H), np.float32),
                                    ct.TensorType("positions", (T,), np.int32),
                                    ct.TensorType("attention_mask", (1, 1, T, MAX), np.float32)],
                        outputs=[ct.TensorType(out_name, dtype=np.float16)], states=states,
                        minimum_deployment_target=ct.target.iOS18, compute_precision=prec), f"{name}.mlpackage")

    n_layers = tcfg.num_hidden_layers
    cfg = {
        "model_type": "qwen3-asr-decoder-coreml", "source_model": model_name, "max_seq_length": MAX,
        "hidden_size": H, "num_layers": n_layers, "num_heads": tcfg.num_attention_heads,
        "num_kv_heads": tcfg.num_key_value_heads, "head_dim": tcfg.head_dim,
        "intermediate_size": tcfg.intermediate_size, "vocab_size": tcfg.vocab_size, "rms_norm_eps": tcfg.rms_norm_eps,
        "rope_theta": float(tcfg.rope_theta), "quantization": "int8_linear_symmetric_per_channel",
        "audio_output_dim": acfg.output_dim,
        "decoder_split": {"enabled": True, "part1_layers": split, "part2_layers": n_layers - split, "split_at": split},
        "enumerated_t": [T],
        "files": {"embedding": "embedding.mlpackage", "decoder_part1": "decoder_part1.mlpackage",
                  "decoder_part2": "decoder_part2.mlpackage", "encoder": "encoder.mlpackage"},
    }
    with open(os.path.join(out, "config.json"), "w") as f:
        json.dump(cfg, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default="out")
    ap.add_argument("--name", default="Qwen/Qwen3-ASR-1.7B")
    ap.add_argument("--check", help="16 kHz mono wav: compare the export's transcript with the official one")
    ap.add_argument("--fp16", action="store_true", help="with --check: run the export graphs in fp16")
    ap.add_argument("--int8", action="store_true",
                    help="with --check: round weights as the converter quantizes them (int8 symmetric per channel)")
    ap.add_argument("--no-convert", action="store_true")
    ap.add_argument("--only", help="convert just this part (encoder, embedding, decoder_part1, decoder_part2)")
    ap.add_argument("--precision", default="fp16", choices=["fp16", "fp32"])
    ap.add_argument("--no-quantize", action="store_true")
    ap.add_argument("--dump", help="with --check: save reference tensors (npz) for verify.py on a Mac")
    a = ap.parse_args()
    torch.set_grad_enabled(False)
    m = load(a.model)
    enc, emb, p1, p2, split = build(m)
    if a.check and a.int8:
        fake_int8(m)
    if a.check:
        check(a.model, m, enc, emb, p1, p2, a.check, a.fp16)
        if a.dump:
            dump(a.model, enc, emb, p1, p2, a.check, a.dump)
    if not a.no_convert:
        th = m.thinker
        convert(enc, emb, p1, p2, split, th.config.text_config, th.config.audio_config, a.out, a.name,
                a.only, a.precision, not a.no_quantize)


if __name__ == "__main__":
    main()
