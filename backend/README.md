# IconiQ Server 🚀

Advanced Node.js server for automated content creation, AI integrations, and media management.

## 🌟 Key Features

- **Generative AI**: Text and Image generation using OpenAI (GPT-4) and Google Gemini.
- **Instagram Automation**: End-to-end flow for analyzing content, generating creative posts, and auto-scheduling.
- **Image Proxy**: Secure access to private Backblaze B2 storage via a backend proxy.
- **Payment Processing**: Integration with Cardcom (Meshulam) and Green Invoice.
- **Gallery Management**: API for retrieving user-specific media galleries.
- **Lead Generation**: Automated WhatsApp initial contact messages for Facebook Leads.

---

## 📂 Project Structure

The project follows a classic MVC architecture:

- **`/controllers`**: Handle HTTP requests and bridge Logic and Routing.
  - `ai.controller.js`: Core AI operations (Images, Text, WhatsApp).
  - `instagram.controller.js`: Social media post generation flow.
  - `image-proxy.controller.js`: Secure media delivery.
  - `payment.controller.js`: Payment gateway integration.
- **`/services`**: Business logic and external API integrations.
  - `openai.service.js`: GPT-4 integration.
  - `gemini.service.js` & `ai-agents/gemini`: Advanced image generation agents.
  - `backblaze.service.js`: Cloud storage management.
  - `instagram.service.js`: Orchestrates the content creation pipeline.
- **`/middlewares`**:
  - `image-security.middleware.js`: Protects the image proxy from path traversal attacks and validates requests.
- **`/routes`**: API Endpoint definitions.

---

## 🔌 API Documentation

### 🖼️ Image Proxy & Gallery

#### 1. Get Image

Securely fetch an image from Backblaze B2 storage.

- **Endpoint**: `GET /img`
- **Query Params**: `url` (The full path to the file in storage)
- **Success Response**: Binary Image Stream (image/png, image/jpeg, etc.)

**Example Request:**

```http
GET http://localhost:3900/img?url=post/0526761204/instagram-1770706958844.png
```

#### 2. Get User Gallery

Retrieve all images associated with a specific phone number.

- **Endpoint**: `GET /api/gallery/:phone`
- **Response**:

```json
{
  "success": true,
  "phone": "0526761204",
  "images": [
    "http://localhost:3900/img?url=post/0526761204/img1.png",
    "http://localhost:3900/img?url=post/0526761204/img2.png"
  ],
  "count": 2
}
```

---

### � Instagram Automation

#### 1. Generate Post

Start an asynchronous job to generate a new Instagram post (Text + Image).

- **Endpoint**: `POST /api/instagram/generate`
- **Body**:

```json
{
  "phone": "0500000000",
  "brandProfile": {
    "name": "My Brand",
    "tone": "Professional"
  },
  "subject": "New Summer Collection",
  "platform": "instagram"
}
```

- **Response**:

```json
{
  "success": true,
  "message": "Post generation started",
  "data": {
    "jobId": "job-1770706958844"
  }
}
```

#### 2. Get Job Status

Check the status of a generation job.

- **Endpoint**: `GET /api/instagram/jobs/:jobId`
- **Response**:

```json
{
  "success": true,
  "data": {
    "jobId": "job-1770706958844",
    "status": "completed",
    "result": {
      "text": "Check out our new timeline...",
      "imageUrl": "..."
    }
  }
}
```

---

### 🤖 AI Capabilities

#### 1. Generate WhatsApp Lead Message

Generate a personalized initial message for a new lead.

- **Endpoint**: `POST /api/ai/whatsapp-lead-message`
- **Body**:

```json
{
  "lead_id": "12345",
  "name": "Israel Israeli",
  "phone": "0501234567",
  "answers": {
    "campaign_name": "Summer Sale",
    "service": "Consulting"
  }
}
```

#### 2. Generate Image (Direct)

Generate an image using Gemini and get the binary data.

- **Endpoint**: `POST /api/ai/images/create`
- **Body**:

```json
{
  "prompt": "A futuristic city skyline at sunset, cyberpunk style",
  "aspectRatio": "1:1"
}
```

#### 3. Create Image Batch Job

Start a background job to generate multiple images based on Q&A.

- **Endpoint**: `POST /api/ai/image-batch/create`
- **Body**:

```json
{
  "phone": "0500000000",
  "questionsAndAnswers": {
    "What is your business?": "Coffee Shop",
    "Style preference?": "Minimalist"
  }
}
```

---

### 💰 Payments

#### 1. Create Payment Link

Generate a payment page URL via Cardcom/Meshulam.

- **Endpoint**: `POST /api/payment/create-payment-link`
- **Body**:

```json
{
  "sum": 100,
  "description": "Consulting Session",
  "customerName": "John Doe",
  "phone": "0500000000",
  "email": "john@example.com"
}
```

- **Response**:

```json
{
  "url": "https://secure.cardcom.solutions/..."
}
```

---

## 🔄 Version Management (Support App)

The support web app (`/public/webApp`) includes a built-in version update notification system.

### How it works

1. **What's New Modal** — on first load after a version bump, agents see a modal listing what changed since their last session. Dismissed once → never shown again until the next version.
2. **Live Update Banner** — the server can push a notification to all connected agents (and future ones) to reload the app and get the latest version.

### Releasing a new version

#### Step 1 — Generate the changelog automatically

Open Claude Code in this project and run:

```text
/release         # bumps patch:  1.1.0 → 1.1.1
/release minor   # bumps minor:  1.1.0 → 1.2.0
/release major   # bumps major:  1.1.0 → 2.0.0
```

This skill reads all uncommitted `git diff`, summarizes the changes in Hebrew, and updates `public/webApp/src/constants/version.js` with the new version number and changelog automatically.

#### Step 2 — Notify connected agents

After deploying, trigger the live update banner for all agents from any browser console (logged in as an agent):

```js
window.io().emit('trigger_version_update')
```

All currently connected agents will see a banner: **"יש עדכון לאתר"** with a refresh button.
Agents who connect later will also receive the notification automatically (the flag persists in server memory until the next restart).

### Version file location

`public/webApp/src/constants/version.js` — edit this manually if needed:

```js
export const APP_VERSION = '1.1.0'   // ← bump this
export const CHANGELOG = [ ... ]      // ← update entries
```

---

## 🛠️ Setup & Configuration

### Environment Variables (.env)

Create a `.env` file in the root directory with the following keys:

```env
# Server Configuration
PORT=3900
MONGO_URI=mongodb+srv://...

# AI Services
OpenAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=AIza...

# Storage (Backblaze B2)
BACKBLAZE_BUCKET_ID=...
BACKBLAZE_KEY_ID=...
BACKBLAZE_APPLICATION_KEY=...

# Payment Gateways
MESHULAM_PAGE_CODE=...
MESHULAM_API_KEY=...
GREEN_INVOICE_KEY=...
```

### Installation

```bash
# Install dependencies
npm install

# Start the server
npm start
```

---

## 🧠 Workflows Explained

### Image Proxy Flow

The server acts as a secure gateway to Backblaze B2 storage:

1. Client requests `/img?url=path/to/image`.
2. **Middleware** validates the path (prevents traversal attacks).
3. **Controller** fetches the file from B2 using private credentials.
4. **Stream** pipes the data securely to the client.
   _Note: This allows using private buckets while serving content publicly via the application logic._

### AI Content Generation

1. **Input**: User provides brand details and specific request constraints.
2. **Analysis**: OpenAI analyzes the input and formulates a creative direction.
3. **Drafting**: OpenAI generates the caption, hashtags, and a detailed image prompt.
4. **Visuals**: Google Gemini receives the image prompt and generates high-quality visual assets.
5. **Storage**: Assets are uploaded to Backblaze B2, and metadata is saved to MongoDB.
# deploy test 1776596015
