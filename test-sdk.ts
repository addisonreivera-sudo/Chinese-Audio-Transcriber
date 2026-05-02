import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({});
const f: File = new File([""], "test.wav");
ai.files.upload({ file: "path/to/file" });
ai.files.upload({ file: f });
