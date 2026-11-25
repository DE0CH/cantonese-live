import * as OpenCC from "opencc-js";

// Soniox may answer in Simplified characters; the pages show Hong Kong Traditional.
export const toHK = OpenCC.Converter({ from: "cn", to: "hk" });
