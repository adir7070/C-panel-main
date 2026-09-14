const axios = require("axios");
const { db } = require("../config/db");

class GreenAPIService {
  constructor() {
    this.instanceId = process.env.GREEN_API_INSTANCE_ID;
    this.token = process.env.GREEN_API_TOKEN;
    this.baseUrl =
      process.env.GREEN_API_BASE_URL || `https://api.green-api.com`;

    if (!this.instanceId || !this.token) {
      console.warn("⚠️  Green API credentials not configured");
    }
  }

  isConfigured() {
    return !!(this.instanceId && this.token);
  }

  /* Green API wants the international form: 05XXXXXXXX → 9725XXXXXXXX.
     Callers across the server pass the local form stored on clients. */
  toWhatsAppNumber(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("972")) return digits;
    if (digits.startsWith("0") && digits.length === 10) return `972${digits.slice(1)}`;
    return digits;
  }

  /**
   * Send a text message via WhatsApp
   * @param {string} phoneNumber - Phone number with country code (e.g., "972501234567")
   * @param {string} message - Message text to send
   * @returns {Promise<Object>} Response from Green API
   */
  async sendMessage(phoneNumber, message) {
    if (!this.isConfigured()) throw new Error("green_api_not_configured");
    try {
      const formattedPhone = this.toWhatsAppNumber(phoneNumber) + "@c.us";

      const url = `${this.baseUrl}/waInstance${this.instanceId}/sendMessage/${this.token}`;

      const payload = {
        chatId: formattedPhone,
        message: message,
      };

      console.log(`📤 Sending WhatsApp message to ${phoneNumber}`);

      // a hung request must fail (and be retried), not stall the message worker
      const response = await axios.post(url, payload, { timeout: 15000 });

      console.log(
        `✅ Message sent successfully. ID: ${response.data.idMessage}`,
      );
      db.collection("message_logs").insertOne({
        phoneNumber,
        message,
        timestamp: new Date(),
        status: "sent",
        greenApiResponse: response.data,
      });
      return {
        success: true,
        messageId: response.data.idMessage,
        data: response.data,
      };
    } catch (error) {
      console.error(
        "❌ Green API Error:",
        error.response?.data || error.message,
      );
      throw new Error(
        error.response?.data?.message || "Failed to send WhatsApp message",
      );
    }
  }

  /** Instance settings — `wid` is the WhatsApp number the instance is linked to. */
  async getSettings() {
    const url = `${this.baseUrl}/waInstance${this.instanceId}/getSettings/${this.token}`;
    const response = await axios.get(url, { timeout: 15000 });
    return response.data;
  }

  /**
   * Get account state/status
   * @returns {Promise<Object>} Account state
   */
  async getAccountState() {
    try {
      const url = `${this.baseUrl}/waInstance${this.instanceId}/getStateInstance/${this.token}`;
      const response = await axios.get(url, { timeout: 15000 });
      return response.data;
    } catch (error) {
      console.error("❌ Failed to get account state:", error.message);
      throw error;
    }
  }
}

module.exports = new GreenAPIService();
