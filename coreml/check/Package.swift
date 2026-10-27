// swift-tools-version: 5.10
// Runs the converted model on a Mac (no simulator): transcribes a clip with speech-swift's MLX-free CoreML path and
// times each stage, for each compute-unit choice given. `swift run -c release check MODEL_DIR clip.wav [cpu|ane|all]…`
import PackageDescription

let package = Package(
    name: "check",
    platforms: [.macOS("15.0")],
    dependencies: [
        .package(url: "https://github.com/soniqo/speech-swift", revision: "cbad3be29480825707890490f446b19d7288be2d"),
    ],
    targets: [
        .executableTarget(name: "check", dependencies: [.product(name: "Qwen3ASR", package: "speech-swift")]),
    ]
)
