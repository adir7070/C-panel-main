const axios = require('axios');

const testFlow = async () => {
  const url = 'http://localhost:3900/api/instagram/generate';
  
  const payload = {
    "subject": "באטומי 20-26/02 \n054-2232050",
    "postType": "instagram_story",
    "valueType[]": "מיתוס שכדאי לנפץ",
    "customerStage": "קהל סקרן",
    "tone": "מרגיע ואמין",
    "hook": "למה לבחור בי",
    "cta": "השאירו פרטים",
    "postCount": "1",
    "timestamp": "1770585986117",
    "phone": "0542232050",
    "token": "mock_token",
    "pageId": "671067459413080",
    "logo": {
        "name": "logo.png"
    }
  };

  console.log("Sending request to:", url);
  console.log("Payload:", payload);

  try {
    const response = await axios.post(url, payload);
    console.log("Response Status:", response.status);
    console.log("Response Data:", response.data);
    
    if (response.data.data && response.data.data.jobId) {
        console.log(`\nPolling for Job ${response.data.data.jobId}...`);
        await pollJob(response.data.data.jobId);
    }
  } catch (error) {
    console.error("Error:", error.response ? error.response.data : error.message);
  }
};

const pollJob = async (jobId) => {
    let attempts = 0;
    const maxAttempts = 15; // Increased timeout for OpenAI + Gemini
    
    const interval = setInterval(async () => {
        attempts++;
        try {
            const res = await axios.get(`http://localhost:3900/api/instagram/jobs/${jobId}`);
            const job = res.data.data;
            console.log(`Attempt ${attempts}: Status = ${job.status}`);
            
            if (job.status === 'completed' || job.status === 'failed' || attempts >= maxAttempts) {
                clearInterval(interval);
                console.log("Final Job Data:", job);
            }
        } catch (e) {
            console.log(`Polling error: ${e.message}`);
        }
    }, 2000);
};

testFlow();
