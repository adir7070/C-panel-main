const axios = require('axios');
require('dotenv').config();
const googleAIConfig = require("../config/google-ai.config"); 

const apiKey = process.env.GOOGLE_AI_API_KEY || googleAIConfig.apiKey;

async function listModels() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    console.log(`Requesting ${url}...`);
    const response = await axios.get(url);
    
    console.log("Available Models:");
    if (response.data && response.data.models) {
        response.data.models.forEach(m => {
            console.log(`- ${m.name} (${m.supportedGenerationMethods.join(', ')})`);
        });
    } else {
        console.log("No models found or different response application.");
        console.log(JSON.stringify(response.data, null, 2));
    }

  } catch (error) {
    console.error("Error listing models:", error.message);
    if (error.response) {
        console.error("Response data:", error.response.data);
    }
  }
}

listModels();
