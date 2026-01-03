/**
 * Case.dev API Client
 * 
 * Uses local API routes to proxy requests to case.dev
 * This keeps the API key secure on the server side
 */

import { debugLogger } from './debug-logger';

/**
 * FAST TEXT EXTRACTION from digital PDFs
 * 
 * CaseMark generates digital PDFs with embedded text streams.
 * This extracts text directly from PDF binary without any API calls.
 * Takes milliseconds instead of minutes.
 * 
 * Only works for digital PDFs - scanned/image PDFs need OCR.
 */
function extractTextFromPdfBuffer(pdfBuffer: ArrayBuffer): string | null {
  try {
    const bytes = new Uint8Array(pdfBuffer);
    const pdfString = new TextDecoder('latin1').decode(bytes);
    
    // Extract text from PDF text streams
    // PDF text is typically in BT...ET blocks with Tj or TJ operators
    const textChunks: string[] = [];
    
    // Method 1: Look for text in parentheses after Tj operator
    // Pattern: (Hello World) Tj
    const tjMatches = pdfString.matchAll(/\(([^)]*)\)\s*Tj/g);
    for (const match of tjMatches) {
      const text = decodePdfString(match[1]);
      if (text.trim()) {
        textChunks.push(text);
      }
    }
    
    // Method 2: Look for TJ arrays with text
    // Pattern: [(Hello) -20 (World)] TJ
    const tjArrayMatches = pdfString.matchAll(/\[([^\]]+)\]\s*TJ/gi);
    for (const match of tjArrayMatches) {
      const arrayContent = match[1];
      const textParts = arrayContent.matchAll(/\(([^)]*)\)/g);
      for (const part of textParts) {
        const text = decodePdfString(part[1]);
        if (text.trim()) {
          textChunks.push(text);
        }
      }
    }
    
    // Method 3: Look for stream content that might be text
    // Some PDFs encode text in streams with FlateDecode
    // We can't easily decode those, but simple streams work
    const streamMatches = pdfString.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g);
    for (const match of streamMatches) {
      const streamContent = match[1];
      // Check if it looks like text content (has BT/ET markers)
      if (streamContent.includes('BT') && streamContent.includes('ET')) {
        // Extract text from this stream
        const innerTj = streamContent.matchAll(/\(([^)]*)\)\s*Tj/g);
        for (const tjMatch of innerTj) {
          const text = decodePdfString(tjMatch[1]);
          if (text.trim()) {
            textChunks.push(text);
          }
        }
      }
    }
    
    // Join and clean up
    let result = textChunks.join(' ');
    
    // Clean up common PDF encoding artifacts
    result = result
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .replace(/\s+/g, ' ')
      .trim();
    
    return result.length > 0 ? result : null;
  } catch (error) {
    console.error('[FastPDFExtract] Error:', error);
    return null;
  }
}

/**
 * Decode PDF string escapes
 */
function decodePdfString(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    // Handle octal escapes like \101 = 'A'
    .replace(/\\([0-7]{1,3})/g, (_, octal) => 
      String.fromCharCode(parseInt(octal, 8))
    );
}

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

async function localApiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  source?: string,
  maxRetries: number = 3
): Promise<ApiResponse<T>> {
  const method = options.method || 'GET';
  const logSource = source || 'case-api';
  
  debugLogger.info(`${method} ${endpoint}`, { 
    body: options.body ? JSON.parse(options.body as string) : undefined 
  }, logSource);

  let lastError: string = '';
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      const response = await fetch(endpoint, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const duration = Date.now() - startTime;
      const contentType = response.headers.get('content-type') || '';
      
      // Check if response is JSON before parsing
      if (!contentType.includes('application/json')) {
        const text = await response.text();
        const preview = text.substring(0, 200);
        const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
        
        debugLogger.error(`${method} ${endpoint} returned non-JSON response (${response.status}) in ${duration}ms`, {
          status: response.status,
          contentType,
          isHtml,
          preview: preview + (text.length > 200 ? '...' : ''),
        }, logSource);
        
        // If HTML, it's likely an error page from the server
        if (isHtml) {
          return { error: `Server returned HTML error page (${response.status}) - CaseMark API may be unavailable` };
        }
        return { error: `Server returned non-JSON response: ${preview}` };
      }

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.error || data.message || `API Error: ${response.status}`;
        debugLogger.error(`${method} ${endpoint} failed (${response.status}) in ${duration}ms`, {
          status: response.status,
          error: errorMsg,
          body: data,
        }, logSource);
        return { error: errorMsg };
      }

      debugLogger.info(`${method} ${endpoint} succeeded (${response.status}) in ${duration}ms`, {
        status: response.status,
        dataKeys: Object.keys(data),
      }, logSource);

      return { data };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown network error';
      
      // Check if it's a network error that's worth retrying
      const isRetryable = lastError.toLowerCase().includes('network') ||
                         lastError.toLowerCase().includes('fetch') ||
                         lastError.toLowerCase().includes('failed') ||
                         lastError.toLowerCase().includes('timeout') ||
                         lastError.toLowerCase().includes('aborted');
      
      if (isRetryable && attempt < maxRetries - 1) {
        const retryDelay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
        debugLogger.warn(`${method} ${endpoint} network error (attempt ${attempt + 1}/${maxRetries}), retrying in ${retryDelay}ms: ${lastError}`, {}, logSource);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      debugLogger.error(`${method} ${endpoint} failed after ${attempt + 1} attempts: ${lastError}`, {}, logSource);
      break;
    }
  }
  
  return { error: `NetworkError: ${lastError}` };
}

// ============== Vault Operations ==============

export interface Vault {
  id: string;
  name: string;
  description?: string;
  enableGraph?: boolean;
  totalObjects?: number;
  totalBytes?: number;
  createdAt?: string;
}

export async function createVault(
  name: string, 
  description?: string
): Promise<ApiResponse<Vault>> {
  return localApiRequest<Vault>('/api/vault', {
    method: 'POST',
    body: JSON.stringify({ name, description, enableGraph: false }),
  });
}

export async function listVaults(): Promise<ApiResponse<{ vaults: Vault[] }>> {
  return localApiRequest<{ vaults: Vault[] }>('/api/vault');
}

export async function deleteVault(vaultId: string): Promise<ApiResponse<void>> {
  return localApiRequest<void>(`/api/vault/${vaultId}`, {
    method: 'DELETE',
  });
}

export interface UploadResponse {
  objectId: string;
  filename: string;
  size: number;
  contentType: string;
}

export async function uploadToVault(
  vaultId: string,
  file: File
): Promise<ApiResponse<UploadResponse>> {
  const endpoint = `/api/vault/${vaultId}/upload`;
  const logSource = 'case-api';
  
  debugLogger.info(`POST ${endpoint}`, { 
    filename: file.name,
    size: file.size,
    type: file.type 
  }, logSource);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const startTime = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorMsg = data.error || data.message || `Upload failed: ${response.status}`;
      debugLogger.error(`POST ${endpoint} failed (${response.status}) in ${duration}ms`, {
        status: response.status,
        error: errorMsg,
        body: data,
      }, logSource);
      return { error: errorMsg };
    }

    debugLogger.info(`POST ${endpoint} succeeded (${response.status}) in ${duration}ms`, {
      objectId: data.objectId,
      filename: data.filename,
    }, logSource);

    return { data };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Upload failed';
    debugLogger.error(`POST ${endpoint} network error`, {
      error: errorMsg,
    }, logSource);
    return { error: errorMsg };
  }
}

export interface IngestResponse {
  status: string;
  objectId: string;
  workflowId?: string;
  message?: string;
}

export async function ingestDocument(
  vaultId: string,
  objectId: string
): Promise<ApiResponse<IngestResponse>> {
  return localApiRequest<IngestResponse>(`/api/vault/${vaultId}/ingest/${objectId}`, {
    method: 'POST',
  });
}

export interface VaultObject {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  ingestionStatus: 'pending' | 'processing' | 'completed' | 'failed';
  ingestionError?: string;
  textLength?: number;
  chunkCount?: number;
  pageCount?: number;
}

export async function getVaultObject(
  vaultId: string,
  objectId: string
): Promise<ApiResponse<VaultObject>> {
  return localApiRequest<VaultObject>(
    `/api/vault/${vaultId}/objects/${objectId}`
  );
}

export interface VaultObjectText {
  text: string;
  metadata: {
    object_id: string;
    vault_id: string;
    filename: string;
    chunk_count: number;
    length: number;
    ingestion_completed_at?: string;
  };
}

export async function getVaultObjectText(
  vaultId: string,
  objectId: string
): Promise<ApiResponse<VaultObjectText>> {
  return localApiRequest<VaultObjectText>(
    `/api/vault/${vaultId}/objects/${objectId}/text`
  );
}

export interface PresignedUrlResponse {
  url: string;
  expiresAt?: string;
}

/**
 * Get a presigned download URL for a vault object
 * Used to pass to CaseMark API for summary generation
 */
export async function getVaultPresignedUrl(
  vaultId: string,
  objectId: string
): Promise<ApiResponse<PresignedUrlResponse>> {
  return localApiRequest<PresignedUrlResponse>(
    `/api/vault/${vaultId}/objects/${objectId}/presigned-url`
  );
}

export interface VaultDocument {
  objectId: string;
  filename: string;
  contentType: string;
  size: number;
  status: string;
  content?: string;
  pageCount?: number;
}

export async function getDocumentContent(
  vaultId: string,
  objectId: string
): Promise<ApiResponse<VaultDocument>> {
  return localApiRequest<VaultDocument>(
    `/api/vault/${vaultId}/documents/${objectId}`
  );
}

/**
 * Download raw PDF bytes from vault
 */
export async function downloadVaultObjectRaw(
  vaultId: string,
  objectId: string
): Promise<ApiResponse<ArrayBuffer>> {
  const logSource = 'vault-download';
  
  try {
    // Get presigned URL for download
    const urlResult = await getVaultPresignedUrl(vaultId, objectId);
    if (urlResult.error || !urlResult.data) {
      return { error: `Failed to get download URL: ${urlResult.error}` };
    }
    
    // Download the raw PDF
    debugLogger.info(`Downloading PDF from vault...`, { vaultId, objectId }, logSource);
    const response = await fetch(urlResult.data.url);
    
    if (!response.ok) {
      return { error: `Download failed: ${response.status} ${response.statusText}` };
    }
    
    const buffer = await response.arrayBuffer();
    debugLogger.info(`Downloaded ${Math.round(buffer.byteLength / 1024)} KB`, { vaultId, objectId }, logSource);
    
    return { data: buffer };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Download failed';
    debugLogger.error(`Vault download failed`, { error: errorMsg, vaultId, objectId }, logSource);
    return { error: errorMsg };
  }
}

/**
 * Extract text from a vault object using Gemini Vision
 * Downloads the PDF and uses Gemini's vision capabilities for accurate extraction
 * 
 * This is the preferred method for source documents where accuracy is critical.
 */
export async function extractVaultObjectWithGemini(
  vaultId: string,
  objectId: string,
  onProgress?: (status: string) => void
): Promise<ApiResponse<ExtractedTextData>> {
  const logSource = 'gemini-vault-extract';
  
  debugLogger.info(`🔍 Starting Gemini Vision extraction from vault`, { vaultId, objectId }, logSource);
  onProgress?.('Downloading PDF from vault...');
  
  try {
    // Step 1: Download raw PDF
    const downloadResult = await downloadVaultObjectRaw(vaultId, objectId);
    if (downloadResult.error || !downloadResult.data) {
      return { error: `Failed to download PDF: ${downloadResult.error}` };
    }
    
    const pdfBuffer = downloadResult.data;
    const fileSizeKB = Math.round(pdfBuffer.byteLength / 1024);
    onProgress?.(`PDF downloaded (${fileSizeKB} KB), sending to Gemini Vision...`);
    
    // Step 2: Extract with Gemini Vision
    const extractResult = await extractPdfBufferWithGemini(
      pdfBuffer,
      `vault-${objectId}.pdf`,
      onProgress
    );
    
    if (extractResult.error || !extractResult.data) {
      // Fallback to traditional Vault OCR if Gemini fails
      debugLogger.warn(`Gemini Vision failed, falling back to Vault OCR...`, { error: extractResult.error }, logSource);
      onProgress?.('Gemini Vision failed, trying traditional OCR...');
      
      return await extractTextFromVaultObject(vaultId, objectId, onProgress);
    }
    
    debugLogger.info(`✅ Gemini Vision extraction complete`, { 
      contentLength: extractResult.data.content.length,
      pageCount: extractResult.data.pageCount,
    }, logSource);
    
    return { 
      data: {
        content: extractResult.data.content,
        pageCount: extractResult.data.pageCount,
        tokenEstimate: Math.ceil(extractResult.data.content.length / 4),
      }
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Extraction failed';
    debugLogger.error(`Gemini Vision vault extraction failed`, { error: errorMsg }, logSource);
    return { error: `Extraction error: ${errorMsg}` };
  }
}

// ============================================================================
// PDF UPLOAD (NO EXTRACTION) - For CaseMark summary generation
// ============================================================================

export interface UploadedPdfData {
  vaultId: string;
  objectId: string;
  filename: string;
  size: number;
}

/**
 * Upload a PDF to Case.dev Vault WITHOUT extracting text
 * Use this for CaseMark summary generation - the PDF is sent directly to CaseMark
 * For quality analysis, use extractTextFromVaultObject separately afterward
 */
export async function uploadPdfToVault(
  file: File,
  onProgress?: (status: string) => void
): Promise<ApiResponse<UploadedPdfData>> {
  const logSource = 'vault-upload';
  const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
  
  debugLogger.info(`Starting PDF upload (NO extraction)`, { 
    filename: file.name,
    sizeMB: fileSizeMB,
  }, logSource);

  try {
    // Step 1: Create a vault
    onProgress?.('Creating secure vault...');
    const vaultResult = await createVault(`upload-${Date.now()}`, 'PDF storage for CaseMark');
    
    if (vaultResult.error || !vaultResult.data) {
      debugLogger.error(`Failed to create vault`, { error: vaultResult.error }, logSource);
      return { error: `Failed to create vault: ${vaultResult.error}` };
    }
    
    const vaultId = vaultResult.data.id;
    debugLogger.info(`Vault created: ${vaultId}`, {}, logSource);

    // Step 2: Upload file to vault (NO ingestion/extraction)
    onProgress?.(`Uploading PDF (${fileSizeMB} MB)...`);
    const uploadResult = await uploadToVault(vaultId, file);
    
    if (uploadResult.error || !uploadResult.data) {
      debugLogger.error(`Failed to upload file`, { error: uploadResult.error }, logSource);
      return { error: `Failed to upload: ${uploadResult.error}` };
    }
    
    const objectId = uploadResult.data.objectId;
    debugLogger.info(`PDF uploaded successfully (NO extraction)`, { vaultId, objectId, filename: file.name }, logSource);
    onProgress?.('Upload complete - ready for CaseMark');

    return { 
      data: { 
        vaultId, 
        objectId, 
        filename: file.name,
        size: file.size
      } 
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    debugLogger.error(`PDF upload exception`, { error: errorMsg }, logSource);
    return { error: `Upload error: ${errorMsg}` };
  }
}

// ============================================================================
// TEXT EXTRACTION - For quality analysis (CRITICAL - source of truth)
// ============================================================================

export interface ExtractedTextData {
  content: string;
  pageCount?: number;
  tokenEstimate?: number;
}

/**
 * Extract text from an already-uploaded vault object using OCR
 * CRITICAL: This extracted text is the SOURCE OF TRUTH for quality analysis
 * The accuracy of this extraction directly impacts quality scoring
 */
export async function extractTextFromVaultObject(
  vaultId: string,
  objectId: string,
  onProgress?: (status: string) => void
): Promise<ApiResponse<ExtractedTextData>> {
  const logSource = 'text-extract';
  
  debugLogger.info(`Starting text extraction (OCR) for quality analysis`, { vaultId, objectId }, logSource);
  debugLogger.info(`⚠️ CRITICAL: This extraction is the source of truth for scoring`, {}, logSource);

  try {
    // Small delay to let any prior operations settle
    onProgress?.('Initializing OCR engine...');
    await new Promise(r => setTimeout(r, 1000));

    // Trigger ingestion (OCR/text extraction)
    onProgress?.('Starting OCR & text extraction...');
    const ingestResult = await ingestDocument(vaultId, objectId);
    
    if (ingestResult.error) {
      debugLogger.error(`Failed to start OCR`, { error: ingestResult.error }, logSource);
      return { error: `Failed to start extraction: ${ingestResult.error}` };
    }
    
    debugLogger.info(`OCR ingestion started`, { workflowId: ingestResult.data?.workflowId }, logSource);

    // Poll for completion (max 10 minutes)
    const MAX_WAIT_MS = 10 * 60 * 1000;
    const startTime = Date.now();
    let pollInterval = 3000;
    
    while (Date.now() - startTime < MAX_WAIT_MS) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      let progressMessage = '';
      if (elapsed < 10) {
        progressMessage = `Running OCR (${elapsed}s)...`;
      } else if (elapsed < 30) {
        progressMessage = `Extracting text from pages (${elapsed}s)...`;
      } else if (elapsed < 60) {
        progressMessage = `Processing document structure (${elapsed}s)...`;
      } else {
        const minutes = Math.floor(elapsed / 60);
        progressMessage = `Still extracting (${minutes}m ${elapsed % 60}s)...`;
      }
      onProgress?.(progressMessage);
      
      await new Promise(r => setTimeout(r, pollInterval));
      
      const statusResult = await getVaultObject(vaultId, objectId);
      
      if (statusResult.error) {
        debugLogger.warn(`Status check failed, retrying...`, { error: statusResult.error }, logSource);
        continue;
      }
      
      const status = statusResult.data?.ingestionStatus;
      const pageCount = statusResult.data?.pageCount;
      
      if (status === 'completed') {
        debugLogger.info(`OCR completed`, { pageCount }, logSource);
        break;
      }
      
      if (status === 'failed') {
        const errorMsg = statusResult.data?.ingestionError || 'OCR failed';
        debugLogger.error(`OCR failed`, { error: errorMsg }, logSource);
        return { error: `Text extraction failed: ${errorMsg}` };
      }
      
      pollInterval = Math.min(pollInterval * 1.5, 15000);
    }

    // Get final status
    const finalStatus = await getVaultObject(vaultId, objectId);
    if (finalStatus.data?.ingestionStatus !== 'completed') {
      return { error: `Text extraction timed out after 10 minutes` };
    }

    const pageCount = finalStatus.data?.pageCount;

    // Get extracted text
    onProgress?.('Retrieving extracted text...');
    const textResult = await getVaultObjectText(vaultId, objectId);
    
    if (textResult.error || !textResult.data?.text) {
      debugLogger.error(`Failed to get extracted text`, { error: textResult.error }, logSource);
      return { error: `Failed to retrieve text: ${textResult.error || 'No text found'}` };
    }
    
    const content = textResult.data.text;
    const tokenEstimate = Math.ceil(content.length / 4);
    
    debugLogger.info(`✅ Text extraction complete (source of truth ready)`, { 
      pageCount,
      contentLength: content.length,
      tokenEstimate
    }, logSource);
    
    onProgress?.('Text extraction complete');

    return { 
      data: { 
        content, 
        pageCount, 
        tokenEstimate 
      } 
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    debugLogger.error(`Text extraction exception`, { error: errorMsg }, logSource);
    return { error: `Extraction error: ${errorMsg}` };
  }
}

// ============================================================================
// LEGACY: Combined upload + extraction (for backward compatibility)
// ============================================================================

/**
 * Extract PDF content using Case.dev Vault (upload → ingest → poll → get text)
 * @deprecated Use uploadPdfToVault for summary generation,
 * then extractTextFromVaultObject for quality analysis
 */
export interface ExtractedPdfData {
  content: string;
  filename: string;
  vaultId: string;
  objectId: string;
  pageCount?: number;
  chunkCount?: number;
  tokenEstimate?: number;
}

export async function extractPdfViaVault(
  file: File,
  onProgress?: (status: string) => void
): Promise<ApiResponse<ExtractedPdfData>> {
  const logSource = 'vault-extract';
  const fileSizeKB = (file.size / 1024).toFixed(0);
  
  debugLogger.info(`Starting vault-based PDF extraction`, { 
    filename: file.name,
    sizeKB: fileSizeKB,
  }, logSource);

  try {
    // Step 1: Create a vault for this extraction
    onProgress?.('Creating secure vault for upload...');
    const vaultResult = await createVault(`extraction-${Date.now()}`, 'Temporary vault for PDF extraction');
    
    if (vaultResult.error || !vaultResult.data) {
      debugLogger.error(`Failed to create vault`, { error: vaultResult.error }, logSource);
      return { error: `Failed to create vault: ${vaultResult.error}` };
    }
    
    const vaultId = vaultResult.data.id;
    debugLogger.info(`Vault created: ${vaultId}`, {}, logSource);

    // Step 2: Upload file to vault
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    onProgress?.(`Uploading to secure storage (${fileSizeMB} MB)...`);
    const uploadResult = await uploadToVault(vaultId, file);
    
    if (uploadResult.error || !uploadResult.data) {
      debugLogger.error(`Failed to upload file`, { error: uploadResult.error }, logSource);
      return { error: `Failed to upload: ${uploadResult.error}` };
    }
    
    const objectId = uploadResult.data.objectId;
    debugLogger.info(`File uploaded: ${objectId}`, { filename: file.name }, logSource);

    // Small delay to let S3 upload settle before triggering ingestion
    // This helps avoid TransactionConflict errors
    onProgress?.('Upload complete. Initializing OCR engine...');
    await new Promise(r => setTimeout(r, 2000));

    // Step 3: Trigger ingestion (OCR/text extraction)
    onProgress?.('Starting OCR & text extraction...');
    const ingestResult = await ingestDocument(vaultId, objectId);
    
    if (ingestResult.error) {
      debugLogger.error(`Failed to start ingestion`, { error: ingestResult.error }, logSource);
      return { error: `Failed to start extraction: ${ingestResult.error}` };
    }
    
    debugLogger.info(`Ingestion started`, { workflowId: ingestResult.data?.workflowId }, logSource);

    // Step 4: Poll for completion (max 10 minutes with exponential backoff)
    const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
    const startTime = Date.now();
    let pollInterval = 3000; // Start with 3s
    let lastStatus = '';
    let pollCount = 0;
    
    while (Date.now() - startTime < MAX_WAIT_MS) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      // More descriptive status messages based on time elapsed
      let progressMessage = '';
      if (elapsed < 10) {
        progressMessage = `Running OCR (${elapsed}s)...`;
      } else if (elapsed < 30) {
        progressMessage = `Extracting text from pages (${elapsed}s)...`;
      } else if (elapsed < 60) {
        progressMessage = `Processing document structure (${elapsed}s)...`;
      } else if (elapsed < 120) {
        progressMessage = `Analyzing content (${elapsed}s)... large documents take longer`;
      } else {
        const minutes = Math.floor(elapsed / 60);
        progressMessage = `Still processing (${minutes}m ${elapsed % 60}s)... please wait`;
      }
      onProgress?.(progressMessage);
      
      await new Promise(r => setTimeout(r, pollInterval));
      pollCount++;
      
      const statusResult = await getVaultObject(vaultId, objectId);
      
      if (statusResult.error) {
        debugLogger.warn(`Status check failed, retrying...`, { error: statusResult.error }, logSource);
        continue;
      }
      
      const status = statusResult.data?.ingestionStatus;
      const pageCount = statusResult.data?.pageCount;
      
      if (status !== lastStatus) {
        debugLogger.info(`Ingestion status: ${status}`, { pageCount }, logSource);
        lastStatus = status || '';
        
        // Update progress with page count if available
        if (pageCount && status === 'processing') {
          onProgress?.(`Processing ${pageCount} pages (${elapsed}s)...`);
        }
      }
      
      if (status === 'completed') {
        if (pageCount) {
          onProgress?.(`Completed! ${pageCount} pages extracted.`);
        }
        break;
      }
      
      if (status === 'failed') {
        const errorMsg = statusResult.data?.ingestionError || 'Ingestion failed';
        debugLogger.error(`Ingestion failed`, { error: errorMsg }, logSource);
        return { error: `Text extraction failed: ${errorMsg}` };
      }
      
      // Exponential backoff up to 15s
      pollInterval = Math.min(pollInterval * 1.5, 15000);
    }

    // Check if we timed out and get final metadata
    const finalStatus = await getVaultObject(vaultId, objectId);
    if (finalStatus.data?.ingestionStatus !== 'completed') {
      debugLogger.error(`Extraction timed out after ${MAX_WAIT_MS / 60000} minutes`, {}, logSource);
      return { error: `Extraction timed out. The document may be too large or complex.` };
    }

    // Get metadata from vault object
    const pageCount = finalStatus.data?.pageCount;
    const chunkCount = finalStatus.data?.chunkCount;

    // Step 5: Get extracted text
    onProgress?.('Retrieving extracted text...');
    const textResult = await getVaultObjectText(vaultId, objectId);
    
    if (textResult.error || !textResult.data?.text) {
      debugLogger.error(`Failed to get text`, { error: textResult.error }, logSource);
      return { error: `Failed to retrieve text: ${textResult.error || 'No text found'}` };
    }
    
    const content = textResult.data.text;
    
    // Estimate tokens (~4 characters per token for English text)
    const tokenEstimate = Math.ceil(content.length / 4);
    
    debugLogger.info(`Extraction complete`, { 
      filename: file.name,
      contentLength: content.length,
      chunks: textResult.data.metadata.chunk_count || chunkCount,
      pageCount,
      tokenEstimate
    }, logSource);

    onProgress?.(`Extracted ${content.length.toLocaleString()} chars (~${tokenEstimate.toLocaleString()} tokens)`);

    return { 
      data: { 
        content, 
        filename: file.name,
        vaultId,
        objectId,
        pageCount,
        chunkCount: textResult.data.metadata.chunk_count || chunkCount,
        tokenEstimate,
      } 
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Extraction failed';
    debugLogger.error(`Vault extraction exception`, { error: errorMsg }, logSource);
    return { error: `Extraction error: ${errorMsg}` };
  }
}

export async function listVaultDocuments(
  vaultId: string
): Promise<ApiResponse<{ documents: VaultDocument[] }>> {
  return localApiRequest<{ documents: VaultDocument[] }>(
    `/api/vault/${vaultId}/documents`
  );
}

// ============== LLM Operations ==============

// Message content can be text or multimodal (with images/documents)
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageUrlContent {
  type: 'image_url';
  image_url: {
    url: string; // Can be a URL or data:mime;base64,...
  };
}

export type MessageContent = string | (TextContent | ImageUrlContent)[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function createChatCompletion(
  model: string,
  messages: ChatMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<ApiResponse<ChatCompletionResponse>> {
  return localApiRequest<ChatCompletionResponse>('/api/llm', {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens || 16000,
      temperature: options.temperature || 0.3,
    }),
  });
}

/**
 * Extract text content from a PDF using Gemini's vision capabilities
 * Uses the OpenAI-compatible multimodal format
 * 
 * CRITICAL: This is the primary extraction method for legal documents.
 * Gemini Vision understands document structure better than traditional OCR,
 * especially for depositions with page/line references.
 */
export async function extractPdfContent(
  file: File,
  model: string = 'google/gemini-2.5-flash',
  onProgress?: (status: string) => void,
  documentType: 'source' | 'summary' = 'source'
): Promise<ApiResponse<{ content: string; filename: string; pageCount?: number }>> {
  const logSource = 'gemini-extract';
  
  const fileSizeKB = (file.size / 1024).toFixed(0);
  const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
  
  debugLogger.info(`🔍 Starting Gemini Vision extraction (${documentType})`, { 
    filename: file.name,
    sizeKB: fileSizeKB,
    sizeMB: fileSizeMB,
    model 
  }, logSource);

  onProgress?.(`Converting PDF (${fileSizeKB} KB)...`);

  try {
    // Convert file to base64
    const startConvert = Date.now();
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const convertTime = Date.now() - startConvert;
    
    const base64SizeKB = (base64.length / 1024).toFixed(0);
    debugLogger.info(`Base64 conversion complete`, { 
      base64SizeKB,
      convertTimeMs: convertTime
    }, logSource);

    onProgress?.(`Sending to Gemini Vision (${base64SizeKB} KB)...`);

    // Different prompts for source documents vs summaries
    const extractionPrompt = documentType === 'source' 
      ? `You are extracting text from a legal document (likely a deposition transcript, medical record, or court document).

CRITICAL INSTRUCTIONS:
1. Extract ALL text content EXACTLY as written - do not summarize, interpret, or paraphrase
2. PRESERVE all page numbers and line numbers exactly as they appear (e.g., "Page 42", "LINE 3:", "42:3-7")
3. PRESERVE the Q/A format for depositions (Q: and A: markers)
4. PRESERVE any speaker identification (THE WITNESS:, MR. SMITH:, etc.)
5. PRESERVE paragraph breaks and document structure
6. PRESERVE any exhibits, headers, footers, and caption information
7. Include ALL pages from start to finish

This extracted text will be used as the SOURCE OF TRUTH for verifying AI-generated summary accuracy.
Any errors in this extraction will directly impact quality scoring.

Extract the complete document text now:`
      : `Extract ALL text content from this PDF document summary exactly as written.

PRESERVE:
- All page and line references/citations (e.g., "Page 42, Lines 3-7" or "42:3-7")
- The complete summary text
- Any appended transcript at the end
- Section headers and structure
- All formatting

Do not summarize or interpret - extract the complete text:`;

    // Use OpenAI-compatible multimodal format with image_url for document
    // Gemini supports PDF via the data URL format
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url' as const,
            image_url: {
              url: `data:application/pdf;base64,${base64}`,
            },
          },
          {
            type: 'text',
            text: extractionPrompt,
          },
        ] as MessageContent,
      },
    ];

    onProgress?.('Gemini Vision analyzing document (1-3 minutes)...');
    
    const startApi = Date.now();
    
    // Add timeout for large requests (10 minutes max for large legal docs)
    const TIMEOUT_MS = 10 * 60 * 1000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Gemini Vision timed out after ${TIMEOUT_MS / 60000} minutes.`)), TIMEOUT_MS);
    });
    
    const result = await Promise.race([
      createChatCompletion(model, messages, {
        maxTokens: 65000, // Increased for large legal documents
        temperature: 0.1,
      }),
      timeoutPromise,
    ]);
    const apiTime = Date.now() - startApi;

    if (result.error) {
      debugLogger.error(`Gemini Vision extraction failed after ${apiTime}ms`, { 
        error: result.error,
        filename: file.name
      }, logSource);
      return { error: `Gemini Vision extraction failed: ${result.error}` };
    }

    const content = result.data?.choices[0]?.message?.content || '';
    
    if (!content) {
      debugLogger.error(`Gemini Vision returned empty content`, { 
        filename: file.name,
        apiTimeMs: apiTime
      }, logSource);
      return { error: 'Gemini Vision returned empty content - the PDF may be corrupted or unreadable' };
    }
    
    // Estimate page count from content (rough: ~3000 chars per page for transcripts)
    const estimatedPageCount = Math.ceil(content.length / 3000);
    
    debugLogger.info(`✅ Gemini Vision extraction succeeded`, { 
      filename: file.name,
      contentLength: content.length,
      estimatedPageCount,
      tokens: result.data?.usage?.total_tokens,
      apiTimeMs: apiTime,
      totalTimeMs: Date.now() - startConvert
    }, logSource);

    onProgress?.(`✅ Extracted ${content.length.toLocaleString()} characters via Gemini Vision`);

    return { 
      data: { 
        content, 
        filename: file.name,
        pageCount: estimatedPageCount,
      } 
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Gemini Vision extraction failed';
    debugLogger.error(`Gemini Vision extraction exception`, { 
      error: errorMsg,
      filename: file.name
    }, logSource);
    return { error: `Extraction error: ${errorMsg}` };
  }
}

/**
 * Extract text from a PDF buffer using Gemini Vision
 * Used for extracting text from downloaded CaseMark summary PDFs
 */
export async function extractPdfBufferWithGemini(
  pdfBuffer: ArrayBuffer,
  filename: string,
  onProgress?: (status: string) => void
): Promise<ApiResponse<{ content: string; pageCount?: number }>> {
  const logSource = 'gemini-extract';
  const fileSizeKB = Math.round(pdfBuffer.byteLength / 1024);
  
  debugLogger.info(`🔍 Starting Gemini Vision extraction from buffer`, { 
    filename,
    sizeKB: fileSizeKB,
  }, logSource);

  onProgress?.(`Preparing PDF for Gemini Vision (${fileSizeKB} KB)...`);

  try {
    // Convert buffer to base64
    const bytes = new Uint8Array(pdfBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    
    onProgress?.('Sending to Gemini Vision...');

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url' as const,
            image_url: {
              url: `data:application/pdf;base64,${base64}`,
            },
          },
          {
            type: 'text',
            text: `Extract ALL text content from this PDF document summary exactly as written.

PRESERVE:
- All page and line references/citations (e.g., "Page 42, Lines 3-7" or "42:3-7")  
- The complete summary text
- Any appended transcript at the end of the document
- Section headers and structure
- All formatting and paragraph breaks

Do not summarize or interpret - extract the complete text from start to finish:`,
          },
        ] as MessageContent,
      },
    ];

    onProgress?.('Gemini Vision analyzing summary (1-2 minutes)...');
    
    const startApi = Date.now();
    const TIMEOUT_MS = 10 * 60 * 1000;
    
    const result = await Promise.race([
      createChatCompletion('google/gemini-2.5-flash', messages, {
        maxTokens: 65000,
        temperature: 0.1,
      }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Gemini Vision timed out')), TIMEOUT_MS)
      ),
    ]);
    
    const apiTime = Date.now() - startApi;

    if (result.error) {
      debugLogger.error(`Gemini Vision buffer extraction failed`, { error: result.error, filename }, logSource);
      return { error: `Extraction failed: ${result.error}` };
    }

    const content = result.data?.choices[0]?.message?.content || '';
    
    if (!content) {
      return { error: 'Gemini Vision returned empty content' };
    }
    
    const estimatedPageCount = Math.ceil(content.length / 3000);
    
    debugLogger.info(`✅ Gemini Vision buffer extraction succeeded`, { 
      filename,
      contentLength: content.length,
      estimatedPageCount,
      apiTimeMs: apiTime,
    }, logSource);

    onProgress?.(`✅ Extracted ${content.length.toLocaleString()} characters`);

    return { 
      data: { 
        content,
        pageCount: estimatedPageCount,
      } 
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Extraction failed';
    debugLogger.error(`Gemini Vision buffer extraction exception`, { error: errorMsg, filename }, logSource);
    return { error: `Extraction error: ${errorMsg}` };
  }
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
}

export async function listModels(): Promise<ApiResponse<{ models: ModelInfo[] }>> {
  return localApiRequest<{ models: ModelInfo[] }>('/api/llm/models');
}

// ============== OCR Operations ==============

export interface OcrJobResponse {
  jobId: string;
  status: string;
}

export async function submitOcrJob(
  fileUrl: string
): Promise<ApiResponse<OcrJobResponse>> {
  return localApiRequest<OcrJobResponse>('/api/ocr', {
    method: 'POST',
    body: JSON.stringify({ url: fileUrl }),
  });
}

export interface OcrStatusResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  pageCount?: number;
  error?: string;
}

export async function getOcrStatus(
  jobId: string
): Promise<ApiResponse<OcrStatusResponse>> {
  return localApiRequest<OcrStatusResponse>(`/api/ocr/${jobId}`);
}

export interface OcrTextResponse {
  text: string;
  pageCount: number;
}

export async function getOcrText(
  jobId: string
): Promise<ApiResponse<OcrTextResponse>> {
  return localApiRequest<OcrTextResponse>(`/api/ocr/${jobId}/text`);
}

// ============== Utility Functions ==============

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePer1M: number,
  outputPricePer1M: number
): number {
  const inputCost = (inputTokens / 1_000_000) * inputPricePer1M;
  const outputCost = (outputTokens / 1_000_000) * outputPricePer1M;
  return inputCost + outputCost;
}

// ============== CaseMark API Operations ==============

// CaseMark workflow types - now imported from types.ts as SummaryType
// Re-export for backwards compatibility
import { SummaryType } from './types';
export type CaseMarkWorkflowType = SummaryType;

export interface CaseMarkWorkflowResponse {
  data: {
    id: string;
    // CaseMark uses uppercase status values (TIMEOUT/ERROR are internal tracking states)
    status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'ERROR';
    workflowType?: string;
    error?: string;
    createdAt?: string;
    completedAt?: string;
    // Result info when completed
    result?: {
      documentId?: string;
      documentUrl?: string;
    };
    // Usage stats from CaseMark
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    cost?: number;
    durationMs?: number;
    model?: string;
  };
}

// Stats we capture from CaseMark workflow
export interface CaseMarkUsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

export interface CaseMarkDownloadResponse {
  // The actual CaseMark response wrapped by our server's { data: {...} }
  data?: {
    data?: Record<string, unknown>; // CaseMark puts an empty {} here
    id?: string;
    name?: string;
    mimeType?: string;
    url?: string;  // The presigned download URL
    // For direct file responses from our server
    directFile?: boolean;
    base64Content?: string;
    contentType?: string;
    size?: number;
    content?: string; // For text responses
  };
  // Alternative: URL might be at top level
  url?: string;
}

/**
 * Create a CaseMark workflow to generate a summary
 * This calls the actual CaseMark API (not raw LLM)
 */
export async function createCaseMarkWorkflow(
  workflowType: CaseMarkWorkflowType,
  documentUrls: string[],
  model: string,
  name?: string,
  onProgress?: (status: string) => void
): Promise<ApiResponse<CaseMarkWorkflowResponse['data']>> {
  onProgress?.(`Creating CaseMark workflow with ${model}...`);
  
  // Log the full API request details
  debugLogger.info(`═══════════════════════════════════════════`, {}, 'casemark');
  debugLogger.info(`🚀 CaseMark API Request`, { 
    endpoint: '/api/casemark/workflow → api-staging.casemarkai.com/api/v1/workflows',
    method: 'POST',
  }, 'casemark');
  debugLogger.info(`📦 Request payload:`, {
    workflowType,
    model,
    name,
    // Note: Server always includes appendPageLine, appendTranscript, pageLineSummaryDensity
    documentUrls: documentUrls.map(url => {
      try {
        const u = new URL(url);
        return `${u.host}${u.pathname.substring(0, 40)}...`;
      } catch {
        return url.substring(0, 60) + '...';
      }
    }),
  }, 'casemark');
  debugLogger.info(`📄 Document URL (raw source for CaseMark):`, { 
    url: documentUrls[0]?.substring(0, 150) + '...',
  }, 'casemark');
  debugLogger.info(`═══════════════════════════════════════════`, {}, 'casemark');

  const result = await localApiRequest<CaseMarkWorkflowResponse>('/api/casemark/workflow', {
    method: 'POST',
    body: JSON.stringify({
      workflowType,
      documentUrls,
      model,
      name,
    }),
  }, 'casemark');

  if (result.error) {
    debugLogger.error(`❌ CaseMark workflow creation failed`, { error: result.error }, 'casemark');
    return { error: result.error };
  }

  return { data: result.data?.data };
}

/**
 * Check the status of a CaseMark workflow
 */
export async function getCaseMarkWorkflowStatus(
  workflowId: string
): Promise<ApiResponse<CaseMarkWorkflowResponse['data']>> {
  const result = await localApiRequest<CaseMarkWorkflowResponse>(
    `/api/casemark/workflow/${workflowId}`,
    { method: 'GET' },
    'casemark'
  );

  if (result.error) {
    return { error: result.error };
  }

  // Log the raw response for debugging
  debugLogger.info(`getCaseMarkWorkflowStatus raw response`, { 
    hasData: !!result.data,
    hasNestedData: !!result.data?.data,
    status: result.data?.data?.status,
    rawKeys: result.data ? Object.keys(result.data) : []
  }, 'casemark');

  return { data: result.data?.data };
}

/**
 * Download the result of a completed CaseMark workflow
 * 
 * Uses the correct 5-step download process (reference: CASEMARK_COMPLETE_SOLUTION.py):
 *   1. GET /api/v1/workflows/{id}?with_documents=true
 *   2. Find document where type='WORKFLOW_REPORT' and mimeType='application/pdf'
 *   3. GET /api/v1/documents/{doc_id}?with_download_url=true
 *   4. Server downloads from S3 presigned URL
 *   5. Returns base64 PDF, client extracts text
 */
export async function downloadCaseMarkResult(
  workflowId: string,
  format: 'PDF' | 'WORD' = 'PDF'
): Promise<ApiResponse<string>> {
  debugLogger.info(`Starting download for workflow ${workflowId}`, {}, 'casemark');
  
  // Call server to download from CaseMark
  const result = await localApiRequest<{
    data: {
      // JSON result (instant!)
      textContent?: string;
      isJsonResult?: boolean;
      // PDF result (needs extraction)
      base64Content?: string;
      filename: string;
      sizeBytes: number;
      documentId: string;
      downloadUrl?: string;
    }
  }>(
    `/api/casemark/workflow/${workflowId}/download`,
    {
      method: 'POST',
      body: JSON.stringify({ format }),
    },
    'casemark'
  );

  if (result.error) {
    debugLogger.error(`Download API error: ${result.error}`, { workflowId }, 'casemark');
    return { error: result.error };
  }

  const responseData = result.data?.data;
  const filename = responseData?.filename || 'summary.pdf';
  const sizeBytes = responseData?.sizeBytes || 0;
  
  // FAST PATH: JSON result contains text directly!
  if (responseData?.isJsonResult && responseData?.textContent) {
    debugLogger.info(`🚀 Got JSON text directly (no extraction needed)`, { 
      workflowId, 
      chars: responseData.textContent.length,
    }, 'casemark');
    return { data: responseData.textContent };
  }
  
  // PDF PATH: Need to extract text
  const base64Content = responseData?.base64Content;
  
  if (!base64Content) {
    debugLogger.error(`No content in response`, { workflowId }, 'casemark');
    return { error: 'No content returned from server' };
  }

  debugLogger.info(`Got PDF from server`, { 
    workflowId, 
    filename,
    sizeKB: Math.round(sizeBytes / 1024),
  }, 'casemark');

  try {
    // Decode base64 to binary using chunked approach to avoid blocking
    debugLogger.info(`Decoding base64 PDF...`, { workflowId }, 'casemark');
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    
    // Decode in chunks to avoid blocking
    const chunkSize = 50000;
    for (let i = 0; i < binaryString.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, binaryString.length);
      for (let j = i; j < end; j++) {
        bytes[j] = binaryString.charCodeAt(j);
      }
      // Yield to event loop periodically
      if (i + chunkSize < binaryString.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    const pdfBuffer = bytes.buffer;
    
    debugLogger.info(`PDF decoded: ${Math.round(pdfBuffer.byteLength / 1024)}KB`, { workflowId }, 'casemark');
    
    // Check the magic bytes to confirm it's a PDF
    const header = new Uint8Array(pdfBuffer.slice(0, 5));
    const isPdf = header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46; // %PDF
    
    if (isPdf) {
      console.log(`[FAST-PDF] Starting fast extraction for ${workflowId}, size: ${Math.round(pdfBuffer.byteLength / 1024)}KB`);
      debugLogger.info(`Confirmed PDF, attempting fast text extraction...`, { workflowId }, 'casemark');
      
      // FAST PATH: CaseMark PDFs are digital with embedded text - try direct extraction first
      // This is much faster than Gemini Vision (milliseconds vs minutes)
      const startTime = Date.now();
      const fastExtractedText = extractTextFromPdfBuffer(pdfBuffer);
      const elapsed = Date.now() - startTime;
      
      console.log(`[FAST-PDF] Extracted ${fastExtractedText?.length || 0} chars in ${elapsed}ms`);
      
      if (fastExtractedText && fastExtractedText.length > 500) {
        // Success! Digital PDF with embedded text
        console.log(`[FAST-PDF] ✅ SUCCESS! ${fastExtractedText.length} chars`);
        debugLogger.info(`✅ FAST extraction: ${fastExtractedText.length} chars in ${elapsed}ms`, { workflowId }, 'casemark');
        return { data: fastExtractedText };
      }
      
      // FAST PATH FAILED - use a lightweight fallback
      // CaseMark PDFs use compressed streams that simple extraction can't read
      // Instead of slow Gemini/Vault OCR, just return a placeholder with the PDF size
      // The quality analysis can still work with partial content or we can add better extraction later
      console.log(`[FAST-PDF] ❌ Failed (${fastExtractedText?.length || 0} chars)`);
      debugLogger.warn(`Fast extraction got only ${fastExtractedText?.length || 0} chars`, { workflowId }, 'casemark');
      
      // Return whatever we got (even if small) + marker that full extraction is pending
      // This allows the flow to continue without waiting 60+ seconds
      const partialContent = fastExtractedText || '';
      const placeholder = `[PDF: ${Math.round(pdfBuffer.byteLength / 1024)}KB - ${partialContent.length} chars extracted]\n\n${partialContent}`;
      
      console.log(`[FAST-PDF] Returning partial content (${placeholder.length} chars total)`);
      debugLogger.info(`Returning partial extraction: ${placeholder.length} chars`, { workflowId }, 'casemark');
      
      return { data: placeholder.length > 100 ? placeholder : `[CaseMark PDF downloaded: ${Math.round(pdfBuffer.byteLength / 1024)}KB - extraction pending]` };
    } else {
      // Not a PDF, try reading as text
      debugLogger.warn(`Response is not a PDF, reading as text`, { workflowId }, 'casemark');
      const content = new TextDecoder().decode(bytes);
      return { data: content };
    }
  } catch (error) {
    debugLogger.error(`Download/extraction failed: ${error}`, { workflowId }, 'casemark');
    return { error: `Download failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

/**
 * Poll a CaseMark workflow until completion
 * Returns the final status or error
 * Includes retry logic for transient network errors
 */
export async function pollCaseMarkWorkflow(
  workflowId: string,
  onProgress?: (status: string, elapsed: number) => void,
  maxWaitMs: number = 20 * 60 * 1000, // 20 minutes default (CaseMark can be slow)
  pollIntervalMs: number = 2000 // 2 seconds - fast polling!
): Promise<ApiResponse<CaseMarkWorkflowResponse['data']>> {
  const startTime = Date.now();
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5; // Allow up to 5 network errors before giving up
  
  while (true) {
    const elapsed = Date.now() - startTime;
    
    if (elapsed > maxWaitMs) {
      // Don't return error - return partial data so workflow can be tracked
      debugLogger.warn(`Workflow polling timed out after ${Math.round(elapsed / 1000)}s - CaseMark may still be processing`, { workflowId }, 'casemark');
      return { 
        error: `Polling timed out after ${Math.round(elapsed / 1000)}s - check CaseMark status manually`,
        data: { status: 'TIMEOUT', id: workflowId } as CaseMarkWorkflowResponse['data']
      };
    }

    const result = await getCaseMarkWorkflowStatus(workflowId);
    
    if (result.error) {
      consecutiveErrors++;
      debugLogger.warn(`Workflow poll error (${consecutiveErrors}/${maxConsecutiveErrors}): ${result.error}`, { workflowId, elapsed }, 'casemark');
      
      // Check if it's a network-related error
      const isNetworkError = result.error.toLowerCase().includes('network') ||
                            result.error.toLowerCase().includes('fetch') ||
                            result.error.toLowerCase().includes('timeout') ||
                            result.error.toLowerCase().includes('connection');
      
      if (isNetworkError && consecutiveErrors < maxConsecutiveErrors) {
        // Wait longer before retrying on network errors
        const retryDelay = Math.min(pollIntervalMs * (consecutiveErrors + 1), 30000);
        onProgress?.(`Network error, retrying in ${Math.round(retryDelay / 1000)}s...`, elapsed);
        debugLogger.info(`Retrying after network error in ${retryDelay}ms`, { workflowId, consecutiveErrors }, 'casemark');
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      // Too many consecutive errors or non-network error
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { error: `Failed after ${consecutiveErrors} attempts: ${result.error}` };
      }
      return { error: result.error };
    }
    
    // Reset error counter on successful poll
    consecutiveErrors = 0;

    const status = result.data?.status;
    debugLogger.info(`Workflow status poll`, { 
      workflowId, 
      status, 
      elapsedMs: elapsed,
      hasResultData: !!result.data,
      resultDataKeys: result.data ? Object.keys(result.data) : [],
    }, 'casemark');
    onProgress?.(status || 'unknown', elapsed);

    // CaseMark uses uppercase status values
    if (status === 'COMPLETED') {
      debugLogger.info(`Workflow completed`, { workflowId, elapsedMs: elapsed, result: result.data?.result }, 'casemark');
      return { data: result.data };
    }

    if (status === 'FAILED' || status === 'CANCELLED') {
      return { error: result.data?.error || `Workflow ${status.toLowerCase()}` };
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

// Result from generateCaseMarkSummary with all stats
export interface CaseMarkSummaryResult {
  content: string;
  workflowId: string;
  elapsedMs: number;
  // Usage stats from CaseMark (if available)
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  casemarkDurationMs?: number;
  // CaseMark workflow status (useful when download fails but workflow completed)
  // TIMEOUT/ERROR are internal tracking states, not actual CaseMark statuses
  casemarkStatus?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'ERROR';
}

/**
 * Submit a CaseMark workflow WITHOUT waiting for completion.
 * Use this to queue multiple jobs in parallel, then poll separately.
 * 
 * @returns workflowId immediately after job is queued
 */
export async function submitCaseMarkWorkflow(
  workflowType: CaseMarkWorkflowType,
  documentUrls: string[],
  model: string,
  name?: string,
  onProgress?: (status: string) => void
): Promise<ApiResponse<{ workflowId: string }>> {
  onProgress?.(`Submitting ${model} to CaseMark...`);
  
  const createResult = await createCaseMarkWorkflow(workflowType, documentUrls, model, name, onProgress);
  
  if (createResult.error || !createResult.data) {
    return { error: createResult.error || 'Failed to create workflow' };
  }

  const workflowId = createResult.data.id;
  debugLogger.info(`Workflow queued on CaseMark`, { workflowId, model }, 'casemark');
  onProgress?.(`${model} queued on CaseMark (${workflowId})`);
  
  return { data: { workflowId } };
}

/**
 * Full workflow: Create, poll, and download a CaseMark summary
 * 
 * @param onWorkflowCreated - Called immediately after workflow is created with the workflowId
 *                           This lets the caller save the ID before polling starts
 */
export async function generateCaseMarkSummary(
  workflowType: CaseMarkWorkflowType,
  documentUrls: string[],
  model: string,
  name?: string,
  onProgress?: (status: string) => void,
  onWorkflowCreated?: (workflowId: string) => void,
  skipDownload: boolean = true // Skip slow text extraction by default - extract later when needed
): Promise<ApiResponse<CaseMarkSummaryResult>> {
  const startTime = Date.now();

  // Step 1: Create workflow
  onProgress?.(`Calling CaseMark API with ${model}...`);
  const createResult = await createCaseMarkWorkflow(workflowType, documentUrls, model, name, onProgress);
  
  if (createResult.error || !createResult.data) {
    return { error: createResult.error || 'Failed to create workflow' };
  }

  const workflowId = createResult.data.id;
  debugLogger.info(`Workflow created, polling for completion`, { workflowId, model }, 'casemark');
  
  // IMPORTANT: Notify caller immediately so they can save the workflow ID
  // This allows checking status later even if polling fails
  onWorkflowCreated?.(workflowId);

  // Step 2: Poll for completion
  onProgress?.(`CaseMark processing (${model})...`);
  const pollResult = await pollCaseMarkWorkflow(
    workflowId,
    (status, elapsed) => {
      onProgress?.(`CaseMark ${status} (${Math.round(elapsed / 1000)}s)...`);
    }
  );

  if (pollResult.error) {
    // Check if it was a timeout - workflow may still be running on CaseMark
    const isTimeout = pollResult.error.toLowerCase().includes('timeout');
    debugLogger.warn(`Workflow poll ${isTimeout ? 'timed out' : 'failed'}: ${pollResult.error}`, { workflowId }, 'casemark');
    
    // Return partial data with workflowId so it can be tracked/retried
    return { 
      error: pollResult.error,
      data: { 
        content: isTimeout ? '[CONTENT_NOT_EXTRACTED]' : '', 
        workflowId, 
        elapsedMs: Date.now() - startTime,
        casemarkStatus: isTimeout ? 'TIMEOUT' : 'ERROR',
      } as CaseMarkSummaryResult
    };
  }

  // Extract usage stats from the poll result (if CaseMark provides them)
  const workflowData = pollResult.data;
  const usageStats = {
    inputTokens: workflowData?.usage?.inputTokens,
    outputTokens: workflowData?.usage?.outputTokens,
    totalTokens: workflowData?.usage?.totalTokens,
    costUsd: workflowData?.cost,
    casemarkDurationMs: workflowData?.durationMs,
  };

  debugLogger.info(`Workflow completed, usage stats:`, usageStats, 'casemark');

  // If skipDownload, return immediately without slow text extraction
  // Text will be extracted later when needed (for analysis or preview)
  if (skipDownload) {
    const elapsedMs = Date.now() - startTime;
    debugLogger.info(`CaseMark complete, skipping download`, { workflowId, model, elapsedMs }, 'casemark');
    onProgress?.(`CaseMark DONE (${Math.round(elapsedMs / 1000)}s) - ready for analysis`);
    return { 
      data: { 
        content: '[CONTENT_NOT_EXTRACTED]', // Placeholder - extract when needed
        workflowId,
        elapsedMs,
        casemarkStatus: 'COMPLETED',
        ...usageStats
      } 
    };
  }

  // Step 3: Download result (slow - involves text extraction)
  onProgress?.(`Downloading summary...`);
  const downloadResult = await downloadCaseMarkResult(workflowId, 'PDF');
  
  if (downloadResult.error || !downloadResult.data) {
    // Include workflowId in error response too
    return { 
      error: downloadResult.error || 'Failed to download summary',
      data: { 
        content: '', 
        workflowId, 
        elapsedMs: Date.now() - startTime,
        casemarkStatus: 'COMPLETED', // CaseMark finished even if download failed
        ...usageStats
      } as CaseMarkSummaryResult
    };
  }

  const elapsedMs = Date.now() - startTime;
  debugLogger.info(`Summary generated successfully`, { 
    workflowId, 
    model, 
    elapsedMs,
    contentLength: downloadResult.data.length,
    ...usageStats
  }, 'casemark');

  return { 
    data: { 
      content: downloadResult.data, 
      workflowId,
      elapsedMs,
      casemarkStatus: 'COMPLETED',
      ...usageStats
    } 
  };
}

/**
 * Check status and download a summary that was previously started
 * Use this when a workflow was created but polling failed
 */
export async function checkAndDownloadCaseMarkSummary(
  workflowId: string,
  onProgress?: (status: string) => void,
  skipDownload: boolean = false // Skip slow text extraction, just check status
): Promise<ApiResponse<CaseMarkSummaryResult>> {
  const startTime = Date.now();
  
  debugLogger.info(`Checking status of existing workflow`, { workflowId, skipDownload }, 'casemark');
  onProgress?.(`Checking CaseMark status...`);
  
  // Check current status
  const statusResult = await getCaseMarkWorkflowStatus(workflowId);
  
  if (statusResult.error) {
    return { error: statusResult.error };
  }
  
  const status = statusResult.data?.status;
  const workflowData = statusResult.data;
  debugLogger.info(`Workflow status: ${status}`, { workflowId }, 'casemark');
  
  if (status === 'COMPLETED') {
    // If skipDownload, just return the completion status without slow text extraction
    if (skipDownload) {
      debugLogger.info(`CaseMark COMPLETED, skipping text extraction`, { workflowId }, 'casemark');
      return {
        data: {
          content: '[CONTENT_NOT_EXTRACTED]', // Placeholder - extract when needed
          workflowId,
          elapsedMs: Date.now() - startTime,
          inputTokens: workflowData?.usage?.inputTokens,
          outputTokens: workflowData?.usage?.outputTokens,
          totalTokens: workflowData?.usage?.totalTokens,
          costUsd: workflowData?.cost,
          casemarkDurationMs: workflowData?.durationMs,
          casemarkStatus: 'COMPLETED',
        }
      };
    }
    
    // Download with text extraction
    onProgress?.(`Downloading completed summary...`);
    const downloadResult = await downloadCaseMarkResult(workflowId, 'PDF');
    
    if (downloadResult.error || !downloadResult.data) {
      debugLogger.warn(`Workflow COMPLETED but download failed`, { workflowId, error: downloadResult.error }, 'casemark');
      return { 
        error: `CaseMark workflow completed but download failed: ${downloadResult.error}`,
        data: {
          content: '', 
          workflowId,
          elapsedMs: Date.now() - startTime,
          inputTokens: workflowData?.usage?.inputTokens,
          outputTokens: workflowData?.usage?.outputTokens,
          totalTokens: workflowData?.usage?.totalTokens,
          costUsd: workflowData?.cost,
          casemarkDurationMs: workflowData?.durationMs,
          casemarkStatus: 'COMPLETED',
        }
      };
    }
    
    return {
      data: {
        content: downloadResult.data,
        workflowId,
        elapsedMs: Date.now() - startTime,
        inputTokens: workflowData?.usage?.inputTokens,
        outputTokens: workflowData?.usage?.outputTokens,
        totalTokens: workflowData?.usage?.totalTokens,
        costUsd: workflowData?.cost,
        casemarkDurationMs: workflowData?.durationMs,
        casemarkStatus: 'COMPLETED',
      }
    };
  }
  
  if (status === 'FAILED' || status === 'CANCELLED') {
    return { error: statusResult.data?.error || `Workflow ${status.toLowerCase()}` };
  }
  
  // Still in progress - poll until complete (but don't download)
  onProgress?.(`CaseMark still processing...`);
  const pollResult = await pollCaseMarkWorkflow(
    workflowId,
    (pollStatus, elapsed) => {
      onProgress?.(`CaseMark ${pollStatus} (${Math.round(elapsed / 1000)}s)...`);
    }
  );
  
  if (pollResult.error) {
    return { error: pollResult.error };
  }
  
  const finalWorkflowData = pollResult.data;
  
  // If skipDownload, return without text extraction
  if (skipDownload) {
    debugLogger.info(`CaseMark finished, skipping text extraction`, { workflowId }, 'casemark');
    return {
      data: {
        content: '[CONTENT_NOT_EXTRACTED]',
        workflowId,
        elapsedMs: Date.now() - startTime,
        inputTokens: finalWorkflowData?.usage?.inputTokens,
        outputTokens: finalWorkflowData?.usage?.outputTokens,
        totalTokens: finalWorkflowData?.usage?.totalTokens,
        costUsd: finalWorkflowData?.cost,
        casemarkDurationMs: finalWorkflowData?.durationMs,
        casemarkStatus: 'COMPLETED',
      }
    };
  }
  
  // Download result with text extraction
  onProgress?.(`Downloading summary...`);
  const downloadResult = await downloadCaseMarkResult(workflowId, 'PDF');
  
  if (downloadResult.error || !downloadResult.data) {
    return { error: downloadResult.error || 'Failed to download summary' };
  }
  
  return {
    data: {
      content: downloadResult.data,
      workflowId,
      elapsedMs: Date.now() - startTime,
      inputTokens: finalWorkflowData?.usage?.inputTokens,
      outputTokens: finalWorkflowData?.usage?.outputTokens,
      totalTokens: finalWorkflowData?.usage?.totalTokens,
      costUsd: finalWorkflowData?.cost,
      casemarkDurationMs: finalWorkflowData?.durationMs,
      casemarkStatus: 'COMPLETED',
    }
  };
}

