/**
 * Security middleware for image proxy
 * Validates path parameters to prevent security vulnerabilities
 */

const validateImagePath = (req, res, next) => {
  console.log(`[Middleware] Incoming request query:`, req.query);
  // Priority 1: Direct 'url' parameter (Full Path)
  if (req.query.url) {
    let p = req.query.url;
    // Basic cleanup
    if (p.startsWith("/")) p = p.substring(1);

    // Validate allowed characters & path traversal
    const denyPatterns = ["..", "\\\\", "//", "%2e%2e", "%2f%2f"];
    for (const pattern of denyPatterns) {
      if (p.toLowerCase().includes(pattern)) {
        console.warn(`[Security] Path traversal attempt detected: ${p}`);
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const allowedCharsRegex = /^[0-9A-Za-z._\/-]+$/;
    if (!allowedCharsRegex.test(p)) {
      console.warn(`[Security] Invalid characters in path: ${p}`);
      return res.status(403).json({ error: "Forbidden" });
    }

    req.validatedPath = { fullPath: p };
    return next();
  }

  let p = req.query.p;

  // Fallback to query param logic
  // Handle case where query param has no key (e.g. ?=/path or ?/path)
  if (!p) {
    // Extract raw query string
    const urlParts = req.url.split("?");
    if (urlParts.length > 1) {
      let rawQuery = urlParts[1];
      // Remove leading '=' if present
      if (rawQuery.startsWith("=")) {
        rawQuery = rawQuery.substring(1);
      }
      p = decodeURIComponent(rawQuery);
    }
  }

  if (!p) {
    return res.status(400).json({ error: "Missing path parameter" });
  }

  // Handle leading slash cleanup generally
  if (p.startsWith("/")) p = p.substring(1);

  // Validate allowed characters
  const denyPatterns = ["..", "\\\\", "//", "%2e%2e", "%2f%2f"];
  for (const pattern of denyPatterns) {
    if (p.toLowerCase().includes(pattern)) {
      console.warn(`[Security] Path traversal attempt detected: ${p}`);
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  // Validate allowed characters
  const allowedCharsRegex = /^[0-9A-Za-z._\/-]+$/;
  if (!allowedCharsRegex.test(p)) {
    console.warn(`[Security] Invalid characters in path: ${p}`);
    return res.status(403).json({ error: "Forbidden" });
  }

  // Validate file extension (basic check)
  const allowedExtensions = ["jpg", "jpeg", "png", "webp", "gif"];
  const parts = p.split(".");
  if (parts.length > 1) {
    const ext = parts.pop().toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      console.warn(`[Security] Invalid file extension: ${ext}`);
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  // Attach validated values to request
  // We attach fullPath for the controller to use directly
  // usage: req.validatedPath.fullPath
  req.validatedPath = { fullPath: p };
  next();
};

module.exports = {
  validateImagePath,
};
