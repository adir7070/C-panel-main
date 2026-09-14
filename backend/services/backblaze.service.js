const B2 = require("backblaze-b2");

/**
 * Backblaze B2 Service - Simple file upload for IconicMedia
 */

const BUCKET_NAME = "iconicMedia";

// Cache auth token and bucket ID — B2 tokens are valid for 24h
let _b2Client = null;
let _bucketId = null;
let _downloadUrl = null; // authoritative download host for THIS account (from authorize)
let _authExpiry = 0;

const getB2Client = async () => {
  if (_b2Client && Date.now() < _authExpiry) return _b2Client;
  const b2 = new B2({
    applicationKeyId: process.env.BACKBLAZE_KEY_ID,
    applicationKey:   process.env.BACKBLAZE_APPLICATION_KEY,
  });
  const authRes = await b2.authorize();
  _b2Client  = b2;
  // The account's download cluster (e.g. https://f003.backblazeb2.com) is assigned by B2
  // and is NOT always f002. Hardcoding the host produces a misleading 401 even on a public
  // bucket, so we always use the host B2 returns at authorize time.
  _downloadUrl = (authRes && authRes.data && authRes.data.downloadUrl) || _downloadUrl;
  _authExpiry = Date.now() + 23 * 60 * 60 * 1000; // re-auth after 23h
  _bucketId  = null; // reset bucket cache on re-auth
  return b2;
};

const getBucketId = async (b2) => {
  if (_bucketId) return _bucketId;
  const response = await b2.listBuckets();
  const bucket = response.data.buckets.find(b => b.bucketName === BUCKET_NAME);
  if (!bucket) throw new Error(`Bucket "${BUCKET_NAME}" not found`);
  _bucketId = bucket.bucketId;
  return _bucketId;
};

/**
 * Upload an image to Backblaze B2
 * @param {string} phone - Client phone number (for folder organization)
 * @param {string} filename - Name of the file (e.g., instagram-1234567890.png)
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - File MIME type
 * @returns {Promise<Object>} Upload result with public URL
 */
const uploadImage = async (fullPath, buffer, mimeType) => {
  try {
    console.log(`[Backblaze] Uploading file: "${fullPath}"`);
    console.log(`[Backblaze] Buffer size: ${buffer.length} bytes`);

    const b2 = await getB2Client();
    const bucketId = await getBucketId(b2);

    console.log(`[Backblaze] Bucket ID: ${bucketId}`);

    console.log(`[Backblaze] Full path: ${fullPath}`);

    // Get upload URL
    const uploadUrlResponse = await b2.getUploadUrl({
      bucketId: bucketId,
    });

    console.log(`[Backblaze] Got upload URL`);

    // Upload file
    const uploadResponse = await b2.uploadFile({
      uploadUrl: uploadUrlResponse.data.uploadUrl,
      uploadAuthToken: uploadUrlResponse.data.authorizationToken,
      fileName: fullPath,
      data: buffer,
      mime: mimeType,
    });

    console.log(`[Backblaze] ✅ Upload response:`, {
      fileId: uploadResponse.data.fileId,
      fileName: uploadResponse.data.fileName,
      contentLength: uploadResponse.data.contentLength,
      contentSha1: uploadResponse.data.contentSha1,
    });

    // Verify file exists by listing it
    try {
      const fileList = await b2.listFileNames({
        bucketId: bucketId,
        prefix: fullPath,
        maxFileCount: 1,
      });

      if (fileList.data.files.length === 0) {
        console.error(
          `[Backblaze] ❌ File NOT found after upload: ${fullPath}`,
        );
        throw new Error("File not found after upload");
      }

      console.log(`[Backblaze] ✅ Verified file exists in bucket`);
    } catch (verifyError) {
      console.error(`[Backblaze] ❌ Verification failed:`, verifyError.message);
    }

    // Build the download URL from the account's AUTHORITATIVE host (captured at authorize
    // time above). Never hardcode the cluster (f002/f003): the wrong host returns a
    // misleading 401 even though the bucket is public.
    const host = _downloadUrl || "https://f003.backblazeb2.com";
    const downloadUrl = `${host}/b2api/v2/b2_download_file_by_id?fileId=${uploadResponse.data.fileId}`;

    console.log(`[Backblaze] Download URL: ${downloadUrl}`);

    return {
      fileId: uploadResponse.data.fileId,
      fileName: fullPath,
      publicUrl: downloadUrl,
      contentUrl: downloadUrl,
      size: buffer.length,
    };
  } catch (error) {
    console.error(
      `[Backblaze] ❌ Error uploading file "${fullPath}":`,
      error.message,
    );
    console.error(`[Backblaze] Full error:`, error);
    throw error;
  }
};

/**
 * Delete a file from Backblaze B2
 * @param {string} fileName - Full path of the file (e.g., "phone/filename.png")
 * @param {string} fileId - File ID from upload
 * @returns {Promise<Object>} Delete result
 */
const deleteImage = async (fileName, fileId) => {
  return "not in Use";
  try {
    console.log(`[Backblaze] Deleting file: "${fileName}"`);

    const b2 = await getB2Client();

    await b2.deleteFileVersion({
      fileId: fileId,
      fileName: fileName,
    });

    console.log(`[Backblaze] ✅ Deleted: "${fileName}"`);
    return { success: true };
  } catch (error) {
    console.error(
      `[Backblaze] Error deleting file "${fileName}":`,
      error.message,
    );
    throw error;
  }
};

/**
 * List all files for a specific phone number
 * @param {string} phone - Client phone number
 * @returns {Promise<Array>} List of files
 */
const listClientImages = async (phone) => {
  try {
    console.log(`[Backblaze] Listing images for client: ${phone}`);

    const b2 = await getB2Client();
    const bucketId = await getBucketId(b2);

    const folders = ["ad-campaigns", "avatar", "post", "profile", "ai-creation"];
    const imageExtensions = ["jpg", "jpeg", "png", "webp", "gif"];

    const results = await Promise.all(
      folders.map((folder) =>
        b2.listFileNames({
          bucketId,
          prefix: `${folder}/${phone}/`,
          maxFileCount: 200,
        })
      )
    );

    const allFiles = results.flatMap((r) => r.data.files);

    console.log(`[Backblaze] Found ${allFiles.length} image(s) for ${phone}`);

    const imageFiles = allFiles.filter((file) => {
      const ext = file.fileName.split(".").pop().toLowerCase();
      return imageExtensions.includes(ext);
    });

    return imageFiles.map((file) => ({
      fileName: file.fileName,
      fileId: file.fileId,
      uploadedAt: new Date(file.uploadTimestamp),
      size: file.contentLength,
    }));
  } catch (error) {
    console.error(`[Backblaze] Error listing files:`, error.message);
    throw error;
  }
};

/**
 * Download an image by phone and filename
 * @param {string} phone - Client phone number
 * @param {string} fileName - File name (without phone prefix)
 * @returns {Promise<Object>} File data and metadata
 */
/**
 * Download an image by full path
 * @param {string} path - Full path of the file (e.g., "phone/filename.png")
 * @returns {Promise<Object>} File data and metadata
 */
const downloadImageByPath = async (path) => {
  try {
    const b2 = await getB2Client();

    // Download directly by name
    const downloadResponse = await b2.downloadFileByName({
      bucketName: BUCKET_NAME,
      fileName: path,
      responseType: "arraybuffer",
    });

    // Determine content type from file extension
    const fileName = path.split("/").pop();
    const ext = fileName.split(".").pop().toLowerCase();
    const mimeTypes = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      pdf: "application/pdf",   // documents (e.g. invoices) sent to clients in-chat
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";

    return {
      buffer: Buffer.from(downloadResponse.data),
      contentType: contentType,
      fileName: fileName,
      size: downloadResponse.data.length || downloadResponse.data.byteLength,
    };
  } catch (error) {
    console.error(`[Backblaze] Error downloading image:`, error.message);
    throw error;
  }
};

/**
 * List all avatar files for a specific phone number
 * @param {string} phone - Client phone number
 * @returns {Promise<Array>} List of avatar files
 */
const listClientAvatars = async (phone) => {
  try {
    console.log(`[Backblaze] Listing avatars for client: ${phone}`);

    const b2 = await getB2Client();
    const bucketId = await getBucketId(b2);

    const response = await b2.listFileNames({
      bucketId: bucketId,
      prefix: `avatar/${phone}/`,
      maxFileCount: 20,
    });

    const imageExtensions = ["jpg", "jpeg", "png", "webp"];
    const imageFiles = response.data.files.filter((file) => {
      const ext = file.fileName.split(".").pop().toLowerCase();
      return imageExtensions.includes(ext);
    });

    return imageFiles.map((file) => ({
      fileName: file.fileName,
      fileId: file.fileId,
      uploadedAt: new Date(file.uploadTimestamp),
      size: file.contentLength,
    }));
  } catch (error) {
    console.error(`[Backblaze] Error listing avatars:`, error.message);
    throw error;
  }
};

/**
 * Delete a single avatar file for a specific phone number.
 * Safety guarantees:
 *   1. fileName MUST start with "avatar/{phone}/" — cannot touch other users or folders.
 *   2. fileId is resolved server-side from Backblaze (not trusted from client).
 *   3. Exactly one file is deleted — uses deleteFileVersion with specific fileId.
 *
 * @param {string} phone    - Client phone number (used to validate path ownership)
 * @param {string} fileName - Full Backblaze path, e.g. "avatar/05.../1234_0.png"
 * @returns {Promise<{ success: boolean, fileName: string }>}
 */
const deleteAvatarFile = async (phone, fileName) => {
  // ── Guard 1: fileName must belong to this phone ──────────────────────────
  const requiredPrefix = `avatar/${phone}/`;
  if (!fileName.startsWith(requiredPrefix)) {
    throw new Error(
      `[deleteAvatarFile] ❌ REJECTED — fileName "${fileName}" does not match prefix "${requiredPrefix}"`
    );
  }

  // ── Guard 2: fileName must not contain path traversal ────────────────────
  const relativePart = fileName.slice(requiredPrefix.length);
  if (relativePart.includes("/") || relativePart.includes("..")) {
    throw new Error(
      `[deleteAvatarFile] ❌ REJECTED — fileName contains illegal path segments`
    );
  }

  console.log(`[deleteAvatarFile] Looking up fileId for: "${fileName}"`);

  const b2 = await getB2Client();
  const bucketId = await getBucketId(b2);

  // ── Step 1: Resolve the fileId from Backblaze (never from client) ─────────
  const listResponse = await b2.listFileNames({
    bucketId,
    prefix: fileName,      // exact fileName as prefix → returns only this file
    maxFileCount: 5,       // safety cap; we expect exactly 1
  });

  const matches = listResponse.data.files.filter((f) => f.fileName === fileName);

  if (matches.length === 0) {
    throw new Error(`[deleteAvatarFile] ❌ File not found: "${fileName}"`);
  }
  if (matches.length > 1) {
    // Should never happen with B2 (one live version), but guard anyway
    throw new Error(
      `[deleteAvatarFile] ❌ Ambiguous — ${matches.length} files match "${fileName}", aborting`
    );
  }

  const { fileId } = matches[0];
  console.log(`[deleteAvatarFile] Found fileId: ${fileId} for "${fileName}"`);

  // ── Step 2: Delete exactly this one file version ──────────────────────────
  await b2.deleteFileVersion({ fileId, fileName });

  console.log(`[deleteAvatarFile] ✅ Deleted: "${fileName}" (fileId: ${fileId})`);
  return { success: true, fileName };
};

/**
 * List all files under a given prefix (folder) in the bucket.
 * @param {string} prefix - e.g. "ad-campaigns/05x/campaign-xxx/"
 * @param {number} maxCount
 * @returns {Promise<Array<{ fileName, fileId, size, uploadTimestamp }>>}
 */
const listFilesByPrefix = async (prefix, maxCount = 100) => {
  try {
    const b2 = await getB2Client();
    const bucketId = await getBucketId(b2);
    const response = await b2.listFileNames({
      bucketId,
      prefix,
      maxFileCount: maxCount,
    });
    return response.data.files || [];
  } catch (error) {
    console.error(`[Backblaze] Error listing prefix "${prefix}":`, error.message);
    throw error;
  }
};

/**
 * Get a one-time upload URL + auth token for direct uploads to the bucket.
 * Make.com can use these to upload files directly without going through the server.
 * @returns {Promise<{ uploadUrl, uploadAuthToken, bucketId }>}
 */
const getUploadCredentials = async () => {
  try {
    const b2 = await getB2Client();
    const bucketId = await getBucketId(b2);
    const uploadUrlResponse = await b2.getUploadUrl({ bucketId });
    return {
      uploadUrl: uploadUrlResponse.data.uploadUrl,
      uploadAuthToken: uploadUrlResponse.data.authorizationToken,
      bucketId,
    };
  } catch (error) {
    console.error("[Backblaze] Error getting upload credentials:", error.message);
    throw error;
  }
};

/**
 * Build the public, by-NAME download URL for a path in the bucket.
 * The bucket is public, so `/file/<bucket>/<path>` is directly reachable with
 * no auth token. Unlike the by-fileId URL returned by uploadImage(), a by-name
 * URL lets RELATIVE asset paths inside an uploaded HTML page (e.g. WOW landing
 * pages that reference `images/foo.png`) resolve correctly under the same path.
 * @param {string} fullPath - e.g. "wow/clients/<phone>/<session>/index.html"
 * @returns {Promise<string>}
 */
const getPublicUrlForPath = async (fullPath) => {
  await getB2Client(); // ensures _downloadUrl (account download host) is known
  const host = _downloadUrl || "https://f003.backblazeb2.com";
  const encoded = String(fullPath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${host}/file/${BUCKET_NAME}/${encoded}`;
};

/**
 * Upload a file to a specific full path in the bucket and return its public,
 * by-name download URL. Leaner than uploadImage() (no post-upload verify /
 * verbose logging) — intended for bulk static-site publishing (WOW pages).
 * @param {string} fullPath
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<{ fileName: string, publicUrl: string }>}
 */
const uploadPublicFile = async (fullPath, buffer, mimeType) => {
  const b2 = await getB2Client();
  const bucketId = await getBucketId(b2);
  const up = await b2.getUploadUrl({ bucketId });
  await b2.uploadFile({
    uploadUrl: up.data.uploadUrl,
    uploadAuthToken: up.data.authorizationToken,
    fileName: fullPath,
    data: buffer,
    mime: mimeType || "application/octet-stream",
  });
  const host = _downloadUrl || "https://f003.backblazeb2.com";
  const encoded = fullPath.split("/").map(encodeURIComponent).join("/");
  return { fileName: fullPath, publicUrl: `${host}/file/${BUCKET_NAME}/${encoded}` };
};

/**
 * Download a file by its Backblaze fileId (authenticated).
 * Accepts either a raw fileId or a full b2_download_file_by_id URL.
 * @param {string} fileIdOrUrl
 * @returns {Promise<{ buffer: Buffer, fileName: string, size: number }>}
 */
const downloadFileById = async (fileIdOrUrl) => {
  let fileId = fileIdOrUrl;
  if (/^https?:\/\//i.test(fileIdOrUrl)) {
    try {
      const u = new URL(fileIdOrUrl);
      const q = u.searchParams.get("fileId");
      if (q) fileId = q;
    } catch { /* use as-is */ }
  }
  const b2 = await getB2Client();
  const resp = await b2.downloadFileById({ fileId, responseType: "arraybuffer" });
  const fileName = (resp.headers && (resp.headers["x-bz-file-name"] || resp.headers["X-Bz-File-Name"])) || "";
  return {
    buffer: Buffer.from(resp.data),
    fileName,
    size: resp.data.length || resp.data.byteLength,
  };
};

module.exports = {
  uploadImage,
  deleteImage,
  listClientImages,
  listClientAvatars,
  downloadImageByPath,
  downloadFileById,
  deleteAvatarFile,
  listFilesByPrefix,
  getUploadCredentials,
  getPublicUrlForPath,
  uploadPublicFile,
};
