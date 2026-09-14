const { GoogleGenerativeAI } = require("@google/generative-ai");
const googleAIConfig = require("../config/google-ai.config"); 
require('dotenv').config();

// Initialize the API client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || googleAIConfig.apiKey);

async function listModels() {
  try {
    // There isn't a direct "listModels" on the client instance in some versions, 
    // but usually it's accessible via a model manager or similar. 
    // In @google/generative-ai, it might not be directly exposed in the main class as easily as 'getGenerativeModel'.
    // However, let's try to just use a known working model 'gemini-pro' 
    // BUT we will try to make a simple request to confirm connectivity first.
    
    // Actually, I'll essentially try to run a prompt on a few common candidates and see which one survives.
    const candidates = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-001",
        "models/gemini-1.5-flash",
        "gemini-pro",
        "models/gemini-pro",
        "gemini-1.0-pro"
    ];

    console.log("Testing models...");
    
    for (const modelName of candidates) {
        console.log(`Trying ${modelName}...`);
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent("Hello");
            console.log(`SUCCESS: ${modelName}`);
            console.log(result.response.text());
            break; // Found one!
        } catch (e) {
            console.log(`FAILED: ${modelName} - ${e.message.split('\n')[0]}`);
        }
    }

  } catch (error) {
    console.error("Error:", error);
  }
}

listModels();
