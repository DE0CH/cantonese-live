import CoreML
import Foundation
import Qwen3ASR

let args = CommandLine.arguments
let dir = URL(fileURLWithPath: args[1])
let wav = try Data(contentsOf: URL(fileURLWithPath: args[2]))
let audio = wav.dropFirst(44).withUnsafeBytes { raw in raw.bindMemory(to: Int16.self).map { Float($0) / 32768 } }
let units: [String: MLComputeUnits] = ["cpu": .cpuOnly, "ane": .cpuAndNeuralEngine, "all": .all, "gpu": .cpuAndGPU]

func ms(_ t: Date) -> Int { Int(Date().timeIntervalSince(t) * 1000) }

for name in args.dropFirst(3) {
    let cu = units[name]!
    var t = Date()
    let model = try await CoreMLASRModel.fromPretrained(
        encoderModelId: "local", decoderModelId: "local", tokenizerModelId: "local",
        encoderComputeUnits: cu, decoderComputeUnits: cu, cacheDir: dir, offlineMode: true)
    print("[\(name)] load \(ms(t)) ms")
    let mel = model.featureExtractor.processRaw(audio, sampleRate: 16000)
    t = Date()
    let enc = try model.encoder.encode(melData: mel.data, melBins: mel.melBins, timeFrames: mel.timeFrames)
    print("[\(name)] encoder \(ms(t)) ms, \(enc.outputLength) tokens")
    model.decoder.resetCache()
    t = Date()
    _ = try model.decoder.decoderPrefillTokens([151644, 8948, 198])
    print("[\(name)] one decoder dispatch (both halves) \(ms(t)) ms")
    t = Date()
    let text = try model.transcribeWithoutMLX(audio: audio, sampleRate: 16000, language: nil, maxTokens: 200)
    print("[\(name)] transcribe \(audio.count / 16) ms of audio in \(ms(t)) ms: \(text)")
}
