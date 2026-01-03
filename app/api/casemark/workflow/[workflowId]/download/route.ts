import { NextRequest, NextResponse } from 'next/server';

const CASEMARK_API_URL = process.env.CASEMARK_API_URL || 'https://api-staging.casemarkai.com';
const CASEMARK_API_KEY = process.env.CASEMARK_API_KEY || '';

function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [CaseMark Download]`;
  
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}`, data ?? '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️ ${message}`, data ?? '');
  } else {
    console.log(`${prefix} ✓ ${message}`, data ?? '');
  }
}

/**
 * POST /api/casemark/workflow/[workflowId]/download
 * 
 * Download the result of a completed CaseMark workflow using the CORRECT 5-step process.
 * 
 * Reference: CASEMARK_COMPLETE_SOLUTION.py
 * 
 * THE CORRECT DOWNLOAD FLOW:
 *   Step 1: GET /api/v1/workflows/{id}?with_documents=true
 *   Step 2: Find document where type='WORKFLOW_REPORT' and mimeType='application/pdf'
 *   Step 3: GET /api/v1/documents/{doc_id}?with_download_url=true
 *   Step 4: GET {downloadUrl} (presigned S3 URL, no auth needed)
 *   Step 5: Return content
 * 
 * DO NOT USE: POST /api/v1/workflows/{id}/download-result (returns 400/405 errors)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await params;

    if (!CASEMARK_API_KEY) {
      return NextResponse.json(
        { error: 'CaseMark API not configured' },
        { status: 503 }
      );
    }

    log('info', `Starting 5-step download for workflow: ${workflowId}`);

    // =========================================================================
    // STEP 1: Get workflow WITH documents
    // =========================================================================
    log('info', `Step 1: Getting workflow with documents...`);
    
    const workflowUrl = `${CASEMARK_API_URL}/api/v1/workflows/${workflowId}?with_documents=true`;
    const workflowResponse = await fetch(workflowUrl, {
      method: 'GET',
      headers: { 'X-API-Key': CASEMARK_API_KEY },
    });

    if (!workflowResponse.ok) {
      const errorText = await workflowResponse.text();
      log('error', `Failed to get workflow`, { status: workflowResponse.status, error: errorText });
      return NextResponse.json(
        { error: `Failed to get workflow: ${workflowResponse.status} - ${errorText}` },
        { status: workflowResponse.status }
      );
    }

    const workflowData = await workflowResponse.json();
    
    // Handle both direct response and wrapped response
    const workflow = workflowData.data || workflowData;
    const documents = workflow.documents || workflowData.documents || [];
    
    log('info', `Got workflow`, { 
      status: workflow.status, 
      documentCount: documents.length,
      documentTypes: documents.map((d: { type: string; mimeType: string }) => `${d.type}:${d.mimeType}`)
    });

    if (documents.length === 0) {
      log('error', `No documents found in workflow`);
      return NextResponse.json(
        { error: 'No documents found in workflow. Workflow may not be complete.' },
        { status: 404 }
      );
    }

    // =========================================================================
    // STEP 2: Find the document to download
    // =========================================================================
    log('info', `Step 2: Finding document...`);
    
    // Documents include: WORKFLOW_INPUT, WORKFLOW_RESULT, WORKFLOW_REPORT
    // Priority: WORKFLOW_RESULT (JSON - instant text!) > WORKFLOW_REPORT (PDF)
    interface WorkflowDocument {
      id: string;
      type: string;
      mimeType: string;
      filename?: string;
    }
    
    let targetDoc: WorkflowDocument | null = null;
    let useJsonResult = false;
    
    // FAST PATH: Try WORKFLOW_RESULT JSON first (contains text directly!)
    for (const doc of documents as WorkflowDocument[]) {
      if (doc.type === 'WORKFLOW_RESULT' && doc.mimeType === 'application/json') {
        targetDoc = doc;
        useJsonResult = true;
        log('info', `🚀 Found JSON result - will extract text instantly!`);
        break;
      }
    }
    
    // Fallback: WORKFLOW_REPORT PDF
    if (!targetDoc) {
      for (const doc of documents as WorkflowDocument[]) {
        if (doc.type === 'WORKFLOW_REPORT' && doc.mimeType === 'application/pdf') {
          targetDoc = doc;
          log('info', `Using PDF report (JSON not available)`);
          break;
        }
      }
    }
    
    // Fallback: any PDF
    if (!targetDoc) {
      for (const doc of documents as WorkflowDocument[]) {
        if (doc.mimeType === 'application/pdf') {
          targetDoc = doc;
          log('warn', `Using fallback PDF document (type: ${doc.type})`);
          break;
        }
      }
    }

    if (!targetDoc) {
      log('error', `No document found`, { 
        availableTypes: documents.map((d: WorkflowDocument) => `${d.type}:${d.mimeType}`) 
      });
      return NextResponse.json(
        { error: `No document found. Available: ${documents.map((d: WorkflowDocument) => d.type).join(', ')}` },
        { status: 404 }
      );
    }

    const docId = targetDoc.id;
    const filename = targetDoc.filename || (useJsonResult ? 'result.json' : 'summary.pdf');
    log('info', `Found document`, { docId, filename, type: targetDoc.type, mimeType: targetDoc.mimeType });

    // =========================================================================
    // STEP 3: Get document with presigned download URL
    // =========================================================================
    log('info', `Step 3: Getting presigned download URL...`);
    
    const docUrl = `${CASEMARK_API_URL}/api/v1/documents/${docId}?with_download_url=true`;
    const docResponse = await fetch(docUrl, {
      method: 'GET',
      headers: { 'X-API-Key': CASEMARK_API_KEY },
    });

    if (!docResponse.ok) {
      const errorText = await docResponse.text();
      log('error', `Failed to get document`, { status: docResponse.status, error: errorText });
      return NextResponse.json(
        { error: `Failed to get document details: ${docResponse.status} - ${errorText}` },
        { status: docResponse.status }
      );
    }

    const docData = await docResponse.json();
    const document = docData.data || docData;
    const downloadUrl = document.downloadUrl;

    if (!downloadUrl) {
      log('error', `No download URL in response`, { docData });
      return NextResponse.json(
        { error: 'No download URL available from CaseMark' },
        { status: 500 }
      );
    }

    log('info', `Got presigned URL`, { urlLength: downloadUrl.length });

    // =========================================================================
    // STEP 4: Download from S3 presigned URL (no auth needed)
    // =========================================================================
    log('info', `Step 4: Downloading from S3...`);
    
    const downloadResponse = await fetch(downloadUrl);
    
    if (!downloadResponse.ok) {
      log('error', `S3 download failed`, { status: downloadResponse.status });
      return NextResponse.json(
        { error: `Download failed: ${downloadResponse.status}` },
        { status: downloadResponse.status }
      );
    }

    const contentType = downloadResponse.headers.get('content-type') || 'application/pdf';
    const contentLength = downloadResponse.headers.get('content-length');
    
    log('info', `Download successful`, { 
      contentType, 
      contentLength: contentLength ? `${parseInt(contentLength) / 1024}KB` : 'unknown' 
    });

    // =========================================================================
    // STEP 5: Process and return the content
    // =========================================================================
    
    if (useJsonResult) {
      // FAST PATH: JSON contains text directly - no extraction needed!
      try {
        const jsonData = await downloadResponse.json();
        
        // Extract text content from the JSON result
        // CaseMark JSON structure typically has: result.summary, result.content, or direct text
        let textContent = '';
        
        if (typeof jsonData === 'string') {
          textContent = jsonData;
        } else if (jsonData.result) {
          textContent = typeof jsonData.result === 'string' 
            ? jsonData.result 
            : JSON.stringify(jsonData.result, null, 2);
        } else if (jsonData.summary) {
          textContent = jsonData.summary;
        } else if (jsonData.content) {
          textContent = jsonData.content;
        } else if (jsonData.text) {
          textContent = jsonData.text;
        } else {
          // Fallback: stringify the whole thing
          textContent = JSON.stringify(jsonData, null, 2);
        }
        
        log('info', `✅ JSON result extracted instantly!`, { 
          contentLength: textContent.length,
          preview: textContent.substring(0, 100) + '...'
        });
        
        // Return text directly - no need for client-side extraction!
        return NextResponse.json({
          data: {
            textContent, // Direct text - no extraction needed!
            isJsonResult: true,
            filename,
            contentType: 'application/json',
            sizeBytes: textContent.length,
            documentId: docId,
          }
        });
      } catch (jsonError) {
        log('warn', `Failed to parse JSON, falling back to raw text`, { error: jsonError });
        const rawText = await downloadResponse.text();
        return NextResponse.json({
          data: {
            textContent: rawText,
            isJsonResult: true,
            filename,
            contentType: 'text/plain',
            sizeBytes: rawText.length,
            documentId: docId,
          }
        });
      }
    }
    
    // PDF PATH: Return base64 for client-side extraction
    const pdfBuffer = await downloadResponse.arrayBuffer();
    const base64Content = Buffer.from(pdfBuffer).toString('base64');
    
    log('info', `✅ Download complete, returning PDF`, { 
      sizeKB: Math.round(pdfBuffer.byteLength / 1024),
      filename 
    });

    // Return base64 PDF - client will extract text
    return NextResponse.json({
      data: {
        base64Content,
        filename,
        contentType,
        sizeBytes: pdfBuffer.byteLength,
        documentId: docId,
        downloadUrl, // Also include URL in case client wants to use it
      }
    });

  } catch (error) {
    log('error', 'Download failed with exception', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
