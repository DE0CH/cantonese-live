"""On a Mac: run the converted CoreML packages from Python and compare each stage with the PyTorch reference that
`convert.py --check clip.wav --dump ref.npz` saved: encoder output, logits after the first decoder dispatch, logits
after the audio, then the whole greedy transcription through the same loop as the Swift runner.

  python verify.py MODEL_DIR ref.npz [CPU_ONLY|CPU_AND_NE|ALL]
  python verify.py --encoder PATH.mlpackage ref.npz [UNITS]     the encoder alone
"""
import sys

import coremltools as ct
import numpy as np

T, MAX, NEG = 128, 1024, -1e4
IM_START, IM_END, NL, SYSTEM, USER, ASSISTANT = 151644, 151645, 198, 8948, 872, 77091
AUDIO_START, AUDIO_END, ASR_TEXT = 151669, 151670, 151704


def cos(a, b):
    a, b = a.astype(np.float64).ravel(), b.astype(np.float64).ravel()
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-30))


def report(name, got, want):
    got = got.astype(np.float32)
    print(f"{name}: cos {cos(got, want):.6f}, max abs diff {np.abs(got - want).max():.4g}, "
          f"argmax {int(got.argmax()) if got.ndim == 1 else '-'} vs {int(want.argmax()) if want.ndim == 1 else '-'}, "
          f"finite {bool(np.isfinite(got).all())}", flush=True)


class Runner:
    def __init__(self, d, cu):
        load = lambda n: ct.models.MLModel(f"{d}/{n}.mlpackage", compute_units=cu)
        self.emb, self.p1, self.p2 = load("embedding"), load("decoder_part1"), load("decoder_part2")
        self.s1, self.s2 = self.p1.make_state(), self.p2.make_state()
        self.pos = 0
        self.scratch = MAX - (T - 1)

    def chunk(self, rows):
        n = rows.shape[0]
        first = T - n
        e = np.zeros((1, T, rows.shape[1]), np.float32)
        e[0, first:] = rows
        pos = np.array([self.scratch + i for i in range(first)] + [self.pos + i for i in range(n)], np.int32)
        mask = np.full((1, 1, T, MAX), NEG, np.float32)
        for t in range(first, T):
            mask[0, 0, t, : min(self.pos + t - first + 1, self.scratch)] = 0
        self.pos += n
        h = self.p1.predict({"input_embeds": e, "positions": pos, "attention_mask": mask}, state=self.s1)["hidden_state"]
        out = self.p2.predict({"input_embeds": h.astype(np.float32), "positions": pos, "attention_mask": mask},
                              state=self.s2)["logits"]
        return out[0, -1].astype(np.float32)

    def tokens(self, ids):
        rows = np.concatenate([self.emb.predict({"token_id": np.array([[i]], np.int32)})["embedding"][0]
                               for i in ids]).astype(np.float32)
        return self.chunk(rows)


def encode(path, ref, cu):
    enc = ct.models.MLModel(path, compute_units=cu)
    o = enc.predict({"mel": ref["mel"].astype(np.float32), "mel_length": np.array([ref["frames"]], np.int32)})
    n = int(o["output_length"][0])
    print(path, "encoder tokens", n, "reference", ref["embeds"].shape[0])
    report("encoder", o["audio_embeddings"][0, :n], ref["embeds"])
    return o, n


def main():
    if sys.argv[1] == "--encoder":
        encode(sys.argv[2], np.load(sys.argv[3]), getattr(ct.ComputeUnit, sys.argv[4] if len(sys.argv) > 4 else "CPU_ONLY"))
        return
    d, ref = sys.argv[1], np.load(sys.argv[2])
    cu = getattr(ct.ComputeUnit, sys.argv[3] if len(sys.argv) > 3 else "CPU_ONLY")
    o, n = encode(f"{d}/encoder.mlpackage", ref, cu)

    r = Runner(d, cu)
    report("prefix logits", r.tokens([IM_START, SYSTEM, NL]), ref["prefix_logits"])
    last = None
    for i in range(0, n, T):
        last = r.chunk(ref["embeds"][i:min(i + T, n)].astype(np.float32))
    report("audio logits (reference embeds)", last, ref["audio_logits"])

    # Whole transcription the way the Swift runner does it, from the CoreML encoder output.
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(d)
    r = Runner(d, cu)
    r.tokens([IM_START, SYSTEM, NL, IM_END, NL, IM_START, USER, NL, AUDIO_START])
    emb = o["audio_embeddings"][0, :n].astype(np.float32)
    for i in range(0, n, T):
        r.chunk(emb[i:i + T])
    logits = r.tokens([AUDIO_END, IM_END, NL, IM_START, ASSISTANT, NL, ASR_TEXT])
    out = []
    for _ in range(80):
        t = int(logits.argmax())
        if t in (IM_END, 151643):
            break
        out.append(t)
        logits = r.tokens([t])
    print("TRANSCRIPT:", tok.decode(out))


if __name__ == "__main__":
    main()
