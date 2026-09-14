const axios = require("axios");
const { DB } = require("../config/db");

const LIVEDNS_URL = "https://domains.livedns.co.il/API/DomainsAPI.asmx";

// ─── XML helpers ───

function buildWhoisXml(domain) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Whois xmlns="http://tempuri.org/">
      <DomainName>${domain}</DomainName>
      <AvailableForRegisterList></AvailableForRegisterList>
    </Whois>
  </soap:Body>
</soap:Envelope>`;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

function parseAvailability(xml, baseName) {
  const list = extractTag(xml, "AvailableForRegisterList");
  const whoisResult = extractTag(xml, "WhoisResult");

  let available = null;
  let suggestions = [];

  if (list !== null) {
    const tlds = list
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    available = tlds.length > 0;

    // בנה suggestions — כל TLD זמין הופך להצעה
    suggestions = tlds.map((tld) => ({
      domain: `${baseName}.${tld}`,
      tld,
      available: true,
    }));
  } else if (whoisResult) {
    const lower = whoisResult.toLowerCase();
    available = lower.includes("available") || lower.includes("זמין");
  }

  return { available, suggestions, whoisSummary: whoisResult };
}

// ─── Controllers ───

/**
 * GET /api/domain/check?domain=example.co.il
 *
 * תשובת JSON שנשלחת ללקוח (App / UI):
 * {
 *   "success": true,
 *   "domain": "example.co.il",
 *   "available": true,           // null = לא ידוע
 *   "suggestions": [
 *     { "domain": "example.co.il", "tld": "co.il", "available": true },
 *     { "domain": "example.org.il", "tld": "org.il", "available": true }
 *   ],
 *   "whoisSummary": "...",       // טקסט מה-Whois, אופציונלי
 *   "checkedAt": "2026-02-19T10:00:00.000Z"
 * }
 */
exports.checkDomain = async (req, res) => {
  const { domain } = req.query;

  if (!domain) {
    return res.status(400).json({ success: false, message: "Missing domain parameter" });
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/.test(domain)) {
    return res.status(400).json({ success: false, message: "Invalid domain format" });
  }

  // שם בסיסי בלי TLD ראשון (example מתוך example.co.il)
  const baseName = domain.split(".")[0];

  try {
    const soapBody = buildWhoisXml(domain);

    const response = await axios.post(LIVEDNS_URL, soapBody, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "http://tempuri.org/Whois",
      },
      timeout: 15000,
      responseType: "text",
    });

    const xml = typeof response.data === "string" ? response.data : String(response.data);
    const parsed = parseAvailability(xml, baseName);

    return res.json({
      success: true,
      domain,
      available: parsed.available,
      suggestions: parsed.suggestions,
      whoisSummary: parsed.whoisSummary,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Domain] checkDomain error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/domain/register
 * { "domain": "example.co.il", "years": 1 }
 * → placeholder לשימוש עתידי עם credentials של LiveDNS
 */
exports.registerDomain = async (req, res) => {
  return res.status(501).json({
    success: false,
    message: "Domain registration not yet implemented. Coming soon.",
  });
};

const DOMAIN_APPROVE_WEBHOOK = "https://hook.eu2.make.com/kxbf5d745y4xr7uh1l33ik30nn6cswr8";

/**
 * POST /api/domain/approve
 * { "phone": "050xxxxxxx" }
 * → קורא לוובהוק של Make.com לרכישת הדומיין
 */
exports.approveDomain = async (req, res) => {
  const { phone, name, domain } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, message: "Phone required" });
  }
  try {
    const lead = await DB.collection("leads").findOne({ phone }, { projection: { email: 1 } });
    const email = lead?.email || null;

    await axios.post(DOMAIN_APPROVE_WEBHOOK, { phone, name: name || null, domain: domain || null, email });
    console.log(`[Domain] Approved purchase for ${phone} | domain: ${domain} | email: ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("[Domain] approveDomain webhook error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
