const { google } = require('googleapis');
const path = require('path');
const instagramConfig = require('../config/instagram.config');

/**
 * Google Drive Service - Modular functions for Drive operations
 */

// In-memory cache: holds the authenticated Drive client
let _cachedDriveClient = null;

/**
 * Load OAuth2 credentials from DB and cache the Drive client.
 * Called on server start and whenever tokens change (connect/disconnect).
 */
const reloadOAuthClient = async () => {
    try {
        const { getDB } = require('../config/db');
        const doc = await getDB().collection('settings').findOne({ key: 'google_oauth' });
        if (!doc?.refresh_token) {
            _cachedDriveClient = null;
            return;
        }
        let clientId, clientSecret;
        try {
            const f = require(path.join(__dirname, '..', 'client_secret_web.json'));
            const creds = f.web || f.installed;
            clientId = creds.client_id;
            clientSecret = creds.client_secret;
        } catch {
            clientId = process.env.GOOGLE_CLIENT_ID;
            clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        }
        const auth = new google.auth.OAuth2(clientId, clientSecret);
        auth.setCredentials({ refresh_token: doc.refresh_token });
        // Auto-clear cache on token expiry so next call forces re-auth
        auth.on('tokens', (tokens) => {
            if (tokens.refresh_token) {
                console.log('[Drive] New refresh_token received — saving to DB');
                require('../config/db').getDB().collection('settings').updateOne(
                    { key: 'google_oauth' },
                    { $set: { refresh_token: tokens.refresh_token, access_token: tokens.access_token } }
                ).catch(() => {});
            }
        });
        _cachedDriveClient = google.drive({ version: 'v3', auth });
        console.log('[Drive] OAuth2 client loaded from DB');
    } catch (err) {
        console.error('[Drive] Failed to load OAuth2 client:', err.message);
        _cachedDriveClient = null;
    }
};

/**
 * Get authenticated Drive client (OAuth2 from DB).
 */
const getDriveClient = async () => {
    if (_cachedDriveClient) return _cachedDriveClient;
    await reloadOAuthClient();
    if (_cachedDriveClient) return _cachedDriveClient;
    throw new Error('חשבון Google Drive לא מחובר. כנס להגדרות וחבר חשבון.');
};

/**
 * Search for folders by name
 * @param {string} folderName - Name to search for
 * @returns {Promise<Array>} Array of matching folders
 */
const searchFolders = async (folderName) => {
    try {
        console.log(`[Drive] Searching for folders named: "${folderName}"`);
        const drive = await getDriveClient();
        const res = await drive.files.list({
            q: `name contains '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
        });
        console.log(`[Drive] Found ${res.data.files.length} folder(s) matching "${folderName}"`);
        return res.data.files;
    } catch (error) {
        console.error(`[Drive] Error searching for folders:`, error.message);
        throw error;
    }
};

/**
 * Create a new folder
 * @param {string} folderName - Name of the folder to create
 * @param {string} parentFolderId - Optional parent folder ID
 * @returns {Promise<Object>} Created folder metadata
 */
const createFolder = async (folderName, parentFolderId = null) => {
    try {
        console.log(`[Drive] Creating folder: "${folderName}"${parentFolderId ? ` in parent: ${parentFolderId}` : ''}`);
        const drive = await getDriveClient();
        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
        };
        if (parentFolderId) {
            fileMetadata.parents = [parentFolderId];
        }
        const file = await drive.files.create({
            resource: fileMetadata,
            fields: 'id, name',
        });
        console.log(`[Drive] ✅ Created folder: "${file.data.name}" (ID: ${file.data.id})`);
        return file.data;
    } catch (error) {
        console.error(`[Drive] Error creating folder "${folderName}":`, error.message);
        throw error;
    }
};

/**
 * Get or create a client folder under "Social Media Assets"
 * @param {string} phone - Client phone number
 * @returns {Promise<string>} Folder ID
 */
const getOrCreateClientFolder = async (phone) => {
    console.log(`[Drive] Getting or creating client folder for phone: ${phone}`);
    
    try {
        // Step 1: Check if client folder already exists
        let clientFolders = await searchFolders(phone);
        if (clientFolders.length > 0) {
            console.log(`[Drive] ✅ Client folder exists (ID: ${clientFolders[0].id})`);
            // Ensure Service Account has write permissions
            await ensureFolderPermissions(clientFolders[0].id);
            return clientFolders[0].id;
        }

        // Step 2: Find or create the root "Social Media Assets" folder
        const mainFolderName = instagramConfig.FOLDERS.MAIN_FOLDER;
        console.log(`[Drive] Looking for root folder: "${mainFolderName}"`);
        
        let mainFolders = await searchFolders(mainFolderName);
        let parentId;
        
        if (mainFolders.length > 0) {
            parentId = mainFolders[0].id;
            console.log(`[Drive] Root folder exists (ID: ${parentId})`);
            // Ensure Service Account has write permissions on root folder
            await ensureFolderPermissions(parentId);
        } else {
            console.log(`[Drive] Root folder not found, creating...`);
            const rootFolder = await createFolder(mainFolderName);
            parentId = rootFolder.id;
            // New folders created by Service Account already have permissions
        }

        // Step 3: Create client folder
        const clientFolder = await createFolder(phone, parentId);
        return clientFolder.id;
        
    } catch (error) {
        console.error(`[Drive] Failed to get/create client folder:`, error.message);
        throw error;
    }
};

/**
 * Ensure Service Account has write permissions on a folder
 * @param {string} folderId - Folder ID to check/update permissions
 */
const ensureFolderPermissions = async (folderId) => {
    try {
        const drive = await getDriveClient();
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });
        const client = await auth.getClient();
        const serviceAccountEmail = client.email;
        
        console.log(`[Drive] Checking permissions for Service Account: ${serviceAccountEmail}`);
        
        // Check if Service Account already has permissions
        const permissions = await drive.permissions.list({
            fileId: folderId,
            fields: 'permissions(id, emailAddress, role)',
        });
        
        const hasPermission = permissions.data.permissions.some(
            p => p.emailAddress === serviceAccountEmail && (p.role === 'writer' || p.role === 'owner')
        );
        
        if (hasPermission) {
            console.log(`[Drive] ✅ Service Account already has write access`);
            return;
        }
        
        // Grant write permission to Service Account
        console.log(`[Drive] Granting write permission to Service Account...`);
        await drive.permissions.create({
            fileId: folderId,
            resource: {
                role: 'writer',
                type: 'user',
                emailAddress: serviceAccountEmail,
            },
            sendNotificationEmail: false,
        });
        
        console.log(`[Drive] ✅ Service Account now has write access`);
    } catch (error) {
        console.error(`[Drive] Warning: Could not verify/set permissions:`, error.message);
        // Don't throw - continue with upload attempt
    }
};

/**
 * Upload a file to Google Drive
 * @param {string} folderId - Target folder ID
 * @param {string} filename - Name of the file
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - File MIME type
 * @returns {Promise<Object>} Uploaded file metadata
 */
const uploadFile = async (folderId, filename, buffer, mimeType) => {
    try {
        console.log(`[Drive] Uploading file: "${filename}" to folder ID: ${folderId}`);
        const drive = await getDriveClient();
        const { Readable } = require('stream');
        
        const fileMetadata = {
            name: filename,
            parents: [folderId],
        };
        const media = {
            mimeType: mimeType,
            body: Readable.from(buffer),
        };
        
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink, webContentLink',
        });
        
        console.log(`[Drive] ✅ Uploaded: "${file.data.name}" (ID: ${file.data.id})`);
        return file.data;
    } catch (error) {
        console.error(`[Drive] Error uploading file "${filename}":`, error.message);
        throw error;
    }
};

/**
 * Make a file publicly accessible
 * @param {string} fileId - File ID to share
 * @returns {Promise<Object>} File metadata with public links
 */
const makeFilePublic = async (fileId) => {
    try {
        console.log(`[Drive] Making file public: ${fileId}`);
        const drive = await getDriveClient();
        
        // Set permissions to "anyone with the link"
        await drive.permissions.create({
            fileId: fileId,
            resource: {
                role: 'reader',
                type: 'anyone',
            },
        });
        
        // Get the public link
        const file = await drive.files.get({
            fileId: fileId,
            fields: 'webViewLink, webContentLink',
        });
        
        console.log(`[Drive] ✅ File is now public: ${file.data.webViewLink}`);
        return file.data;
    } catch (error) {
        console.error(`[Drive] Error making file public:`, error.message);
        throw error;
    }
};

/**
 * Get all images for a client by phone number
 * @param {string} phone - Client phone number
 * @returns {Promise<Array>} Array of image files
 */
const getClientImages = async (phone) => {
    try {
        console.log(`[Drive] Fetching images for client: ${phone}`);
        
        // Find client folder
        const clientFolders = await searchFolders(phone);
        if (clientFolders.length === 0) {
            console.log(`[Drive] No folder found for client: ${phone}`);
            return [];
        }
        
        const folderId = clientFolders[0].id;
        const drive = await getDriveClient();
        
        const res = await drive.files.list({
            q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: 'files(id, name, webViewLink, webContentLink, createdTime)',
            orderBy: 'createdTime desc',
        });
        
        console.log(`[Drive] Found ${res.data.files.length} image(s) for client: ${phone}`);
        return res.data.files;
    } catch (error) {
        console.error(`[Drive] Error fetching client images:`, error.message);
        throw error;
    }
};

/**
 * Extract Google Drive folder ID from a full Drive URL
 * @param {string} driveUrl - e.g. https://drive.google.com/drive/folders/FOLDER_ID
 * @returns {string|null}
 */
const extractFolderIdFromUrl = (driveUrl) => {
    if (!driveUrl) return null;
    const match = driveUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
};

/**
 * Find or create a date-named subfolder inside a parent folder
 * @param {string} parentFolderId
 * @param {string} dateStr - format dd/mm/yyyy
 * @returns {Promise<string>} folder ID
 */
const findOrCreateDateFolder = async (parentFolderId, dateStr) => {
    console.log(`[Drive] Looking for date folder "${dateStr}" in parent: ${parentFolderId}`);
    const drive = await getDriveClient();
    const res = await drive.files.list({
        q: `'${parentFolderId}' in parents and name = '${dateStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
    });
    if (res.data.files.length > 0) {
        console.log(`[Drive] Found existing date folder: ${res.data.files[0].id}`);
        return res.data.files[0].id;
    }
    const folder = await createFolder(dateStr, parentFolderId);
    return folder.id;
};

/**
 * Upload a chat message file (image/video) to the customer's Drive date subfolder
 * @param {string} driveUrl      - Customer's Drive folder full URL
 * @param {string} fileUrl       - Public URL of the file to upload
 * @param {string} filename      - Desired file name in Drive
 * @param {string} mimeType      - MIME type of the file
 * @param {Date|string} messageDate - Date of the message (for folder naming)
 * @returns {Promise<Object>}    - Uploaded file metadata { id, name, webViewLink }
 */
const uploadMessageFileToDrive = async (driveUrl, fileUrl, filename, mimeType, messageDate) => {
    const parentFolderId = extractFolderIdFromUrl(driveUrl);
    if (!parentFolderId) throw new Error(`Cannot extract folder ID from driveUrl: ${driveUrl}`);

    // Format date as dd/mm/yyyy
    const d = messageDate ? new Date(messageDate) : new Date();
    const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

    // Find or create the date subfolder
    const dateFolderId = await findOrCreateDateFolder(parentFolderId, dateStr);

    // Download file into a Buffer
    console.log(`[Drive] Downloading file: ${fileUrl}`);
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Upload to Drive
    const fileData = await uploadFile(dateFolderId, filename, buffer, mimeType);
    return fileData;
};

/**
 * Find a file by exact name inside a specific folder
 * @param {string} folderId - Drive folder ID to search in
 * @param {string} filename - Exact filename to look for
 * @returns {Promise<Object|null>} File metadata or null if not found
 */
const findFileInFolder = async (folderId, filename) => {
    const drive = await getDriveClient();
    const safeName = filename.replace(/'/g, "\\'");
    const res = await drive.files.list({
        q: `'${folderId}' in parents and name = '${safeName}' and trashed = false`,
        fields: 'files(id, name, webViewLink, webContentLink)',
        pageSize: 1,
    });
    return res.data.files.length > 0 ? res.data.files[0] : null;
};

/**
 * Check if a file already exists in the Drive folder (by name); upload only if missing.
 * @param {string} driveUrl     - Customer's Drive folder full URL
 * @param {string} fileUrl      - Public URL of the source file
 * @param {string} filename     - Desired file name in Drive
 * @param {string} mimeType     - MIME type of the file
 * @param {Date|string} [date]  - Date used for date-subfolder naming (defaults to now)
 * @returns {Promise<{existed: boolean, id, name, webViewLink}>}
 */
const checkAndUploadToDrive = async (driveUrl, fileUrl, filename, mimeType, date) => {
    const parentFolderId = extractFolderIdFromUrl(driveUrl);
    if (!parentFolderId) throw new Error(`Cannot extract folder ID from driveUrl: ${driveUrl}`);

    const d = date ? new Date(date) : new Date();
    const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

    const dateFolderId = await findOrCreateDateFolder(parentFolderId, dateStr);

    // Check if file already exists
    const existing = await findFileInFolder(dateFolderId, filename);
    if (existing) {
        console.log(`[Drive] File already exists: "${filename}" (ID: ${existing.id})`);
        return { existed: true, ...existing };
    }

    // Download & upload
    console.log(`[Drive] File not found — downloading: ${fileUrl}`);
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const fileData = await uploadFile(dateFolderId, filename, buffer, mimeType);
    console.log(`[Drive] Uploaded new file: "${filename}" (ID: ${fileData.id})`);
    return { existed: false, ...fileData };
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * Upload a file to the customer's Drive folder with full error classification.
 * Verifies the customer folder is accessible before downloading or uploading.
 * @param {string} driveUrl     - Customer's Drive folder full URL
 * @param {string} fileUrl      - Public URL of the source file
 * @param {string} filename     - Desired file name in Drive
 * @param {string} mimeType     - MIME type of the file
 * @param {Date|string} [messageDate] - Date for date-subfolder naming (defaults to now)
 * @returns {Promise<Object>}   - Uploaded file metadata { id, name, webViewLink }
 */
const smartUploadToDrive = async (driveUrl, fileUrl, filename, mimeType, messageDate) => {
    const parentFolderId = extractFolderIdFromUrl(driveUrl);
    if (!parentFolderId) {
        const err = new Error('לא ניתן לחלץ מזהה תיקייה מה-URL');
        err.code = 'NO_CUSTOMER_FOLDER';
        throw err;
    }

    // Verify the customer folder exists and is accessible
    const drive = await getDriveClient();
    try {
        await drive.files.get({ fileId: parentFolderId, fields: 'id, name' });
        console.log(`[Drive] Customer folder verified: ${parentFolderId}`);
    } catch (e) {
        const isInvalidGrant = e?.message?.includes('invalid_grant') || e?.response?.data?.error === 'invalid_grant';
        if (isInvalidGrant) {
            _cachedDriveClient = null; // force re-auth on next call
            const err = new Error('חיבור Google Drive פג תוקף — יש להתחבר מחדש');
            err.code = 'TOKEN_EXPIRED';
            throw err;
        }
        const status = e?.response?.status || e?.status;
        const err = new Error(
            status === 404 ? 'תיקיית הדרייב של הלקוח לא נמצאה'
            : status === 403 ? 'אין גישה לתיקיית הדרייב'
            : `שגיאה בגישה לתיקייה: ${e.message}`
        );
        err.code = status === 404 ? 'NO_CUSTOMER_FOLDER'
                 : status === 403 ? 'ACCESS_DENIED'
                 : 'UPLOAD_ERROR';
        throw err;
    }

    // Find/create date subfolder (dd/mm/yyyy)
    const d = messageDate ? new Date(messageDate) : new Date();
    const dateStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const dateFolderId = await findOrCreateDateFolder(parentFolderId, dateStr);

    // Download file
    console.log(`[Drive] Downloading: ${fileUrl}`);
    const response = await fetch(fileUrl);
    if (!response.ok) {
        const err = new Error(`הורדת הקובץ נכשלה: ${response.status} ${response.statusText}`);
        err.code = 'UPLOAD_ERROR';
        throw err;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Upload to Drive
    const fileData = await uploadFile(dateFolderId, filename, buffer, mimeType);
    console.log(`[Drive] Uploaded: "${filename}" → ${fileData.webViewLink}`);
    return fileData;
};

/**
 * Test the Drive connection and optionally list files in a given folder URL.
 * @param {string} [driveUrl] - Optional Drive folder URL to inspect
 * @returns {Promise<Object>} Diagnostic info
 */
const testDriveConnection = async (driveUrl) => {
    const credentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || null;

    // Resolve service account email from credentials
    const auth = new google.auth.GoogleAuth({
        keyFile: credentialsFile,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const client = await auth.getClient();
    const serviceAccount = client.email || null;

    const result = { credentialsFile, serviceAccount, folderTest: null };

    if (driveUrl) {
        const folderId = extractFolderIdFromUrl(driveUrl);
        if (!folderId) throw new Error(`Cannot extract folder ID from: ${driveUrl}`);

        const drive = await getDriveClient();
        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType)',
            pageSize: 20,
            orderBy: 'name',
        });

        result.folderTest = {
            folderId,
            filesFound: res.data.files.length,
            files: res.data.files,
        };
    }

    return result;
};

/**
 * Find an existing subfolder by exact name within a parent folder
 * @param {string} parentFolderId - Parent folder ID
 * @param {string} folderName - Exact folder name to find
 * @returns {Promise<string|null>} Subfolder ID or null if not found
 */
const findSubfolder = async (parentFolderId, folderName) => {
    const drive = await getDriveClient();
    const res = await drive.files.list({
        q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
    });
    return res.data.files.length > 0 ? res.data.files[0].id : null;
};

/**
 * Get images from a nested subfolder path within a client's Drive folder
 * e.g. getClientImagesFromPath(phone, ["לקמפיינר", "נוי מאשרת"])
 * @param {string} phone - Client phone number
 * @param {string[]} subfolderPath - Array of subfolder names to traverse
 * @returns {Promise<Array>} Array of image file objects
 */
const getClientImagesFromPath = async (phone, subfolderPath = []) => {
    try {
        console.log(`[Drive] Fetching images for client: ${phone}, path: ${subfolderPath.join(' → ')}`);

        // Find client folder by phone
        const clientFolders = await searchFolders(phone);
        if (clientFolders.length === 0) {
            console.log(`[Drive] No folder found for client: ${phone}`);
            return [];
        }

        let currentFolderId = clientFolders[0].id;

        // Traverse subfolder path
        for (const folderName of subfolderPath) {
            const subfolderId = await findSubfolder(currentFolderId, folderName);
            if (!subfolderId) {
                console.log(`[Drive] Subfolder "${folderName}" not found in ${currentFolderId}`);
                return [];
            }
            currentFolderId = subfolderId;
            console.log(`[Drive] Entered subfolder "${folderName}" (ID: ${currentFolderId})`);
        }

        // List images in the final folder
        const drive = await getDriveClient();
        const res = await drive.files.list({
            q: `'${currentFolderId}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: 'files(id, name, webViewLink, webContentLink, createdTime)',
            orderBy: 'createdTime desc',
        });

        console.log(`[Drive] Found ${res.data.files.length} image(s) at path`);
        return res.data.files;
    } catch (error) {
        console.error(`[Drive] Error fetching client images from path:`, error.message);
        throw error;
    }
};

/**
 * Get or create a subfolder by exact name within a parent folder
 * @param {string} parentFolderId - Parent folder ID
 * @param {string} folderName - Exact folder name to find/create
 * @returns {Promise<string>} Subfolder ID
 */
const getOrCreateSubfolder = async (parentFolderId, folderName) => {
    console.log(`[Drive] Looking for subfolder "${folderName}" in parent: ${parentFolderId}`);
    const drive = await getDriveClient();
    const res = await drive.files.list({
        q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
    });
    if (res.data.files.length > 0) {
        console.log(`[Drive] Found existing subfolder "${folderName}": ${res.data.files[0].id}`);
        return res.data.files[0].id;
    }
    const folder = await createFolder(folderName, parentFolderId);
    return folder.id;
};

/**
 * Copy a file to a destination folder
 * @param {string} fileId - Source file ID
 * @param {string} destinationFolderId - Target folder ID
 * @returns {Promise<Object>} Copied file metadata { id, name }
 */
/**
 * Get file name from Drive by ID
 */
const getFileName = async (fileId) => {
    const drive = await getDriveClient();
    const res = await drive.files.get({ fileId, fields: 'name' });
    return res.data.name;
};

const copyFile = async (fileId, destinationFolderId, name) => {
    console.log(`[Drive] Copying file ${fileId} to folder ${destinationFolderId}`);
    const drive = await getDriveClient();
    const resource = { parents: [destinationFolderId] };
    if (name) resource.name = name;
    const res = await drive.files.copy({
        fileId,
        resource,
        fields: 'id, name',
    });
    console.log(`[Drive] ✅ Copied file: "${res.data.name}" (ID: ${res.data.id})`);
    return res.data;
};

/**
 * Create a Google Doc with text content in a folder
 * @param {string} folderId - Folder to create the doc in
 * @param {string} title - Document title
 * @param {string} content - Plain text content
 * @returns {Promise<Object>} Created doc metadata { id, name }
 */
const createTextDocument = async (folderId, title, content) => {
    console.log(`[Drive] Creating text document "${title}" in folder ${folderId}`);
    const drive = await getDriveClient();
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(content);
    stream.push(null);

    const res = await drive.files.create({
        resource: {
            name: title,
            mimeType: 'application/vnd.google-apps.document',
            parents: [folderId],
        },
        media: {
            mimeType: 'text/plain',
            body: stream,
        },
        fields: 'id, name',
    });
    console.log(`[Drive] ✅ Created document: "${res.data.name}" (ID: ${res.data.id})`);
    return res.data;
};

/**
 * Append text to an existing Google Doc using Drive API only (no Docs scope needed).
 * Exports current content as plain text, appends new text, re-uploads.
 */
const appendToDocument = async (docId, text) => {
    console.log(`[Drive] Appending text to document ${docId}`);
    const drive = await getDriveClient();
    const { Readable } = require('stream');

    // Export current content as plain text
    const exported = await drive.files.export({
        fileId: docId,
        mimeType: 'text/plain',
    });
    const currentContent = exported.data || '';

    // Build new content with separator
    const newContent = `${currentContent}\n---\n${text}`;

    // Re-upload as plain text (converts back to Google Doc)
    const stream = new Readable();
    stream.push(newContent);
    stream.push(null);

    await drive.files.update({
        fileId: docId,
        media: {
            mimeType: 'text/plain',
            body: stream,
        },
    });
    console.log(`[Drive] ✅ Appended text to document ${docId}`);
};

/**
 * Rewrite a Google Doc with new plain text content (replaces everything).
 */
const rewriteDocument = async (docId, content) => {
    console.log(`[Drive] Rewriting document ${docId}`);
    const drive = await getDriveClient();
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(content);
    stream.push(null);
    await drive.files.update({
        fileId: docId,
        media: {
            mimeType: 'text/plain',
            body: stream,
        },
    });
    console.log(`[Drive] ✅ Rewrote document ${docId}`);
};

/**
 * Delete a file from Google Drive.
 */
const deleteFile = async (fileId) => {
    console.log(`[Drive] Deleting file ${fileId}`);
    const drive = await getDriveClient();
    await drive.files.delete({ fileId });
    console.log(`[Drive] ✅ Deleted file ${fileId}`);
};

/**
 * List all files in a folder (non-folder files only).
 */
const listFilesInFolder = async (folderId) => {
    const drive = await getDriveClient();
    const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name, mimeType, webContentLink, webViewLink, createdTime)',
        orderBy: 'createdTime desc',
    });
    return res.data.files || [];
};

module.exports = {
    reloadOAuthClient,
    searchFolders,
    createFolder,
    getOrCreateClientFolder,
    uploadFile,
    makeFilePublic,
    getClientImages,
    uploadMessageFileToDrive,
    findFileInFolder,
    checkAndUploadToDrive,
    smartUploadToDrive,
    testDriveConnection,
    getOrCreateSubfolder,
    copyFile,
    createTextDocument,
    appendToDocument,
    getFileName,
    findSubfolder,
    getClientImagesFromPath,
    rewriteDocument,
    deleteFile,
    listFilesInFolder,
    getDriveClient,
};
