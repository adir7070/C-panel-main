module.exports = {
  terminal: process.env.CARDCOM_TERMINAL_NUMBER,
  apiName: process.env.CARDCOM_API_NAME,
  apiPassword: process.env.CARDCOM_API_PASSWORD,
  apiUrl: "https://secure.cardcom.solutions/api/v11/LowProfile/Create",
  doTransactionUrl: "https://secure.cardcom.solutions/api/v11/Transactions/Transaction",
  successURL: "https://cardcom.callback/payment-success",
  errorURL: "https://cardcom.callback/payment-error",
  // Legacy consumer-app flows only (monthly plan / coin purchase). The old
  // Make.com receiver belonged to Iconiq; unset = those two flows are disabled.
  notifyURL: process.env.CARDCOM_LEGACY_NOTIFY_URL || null,
};
