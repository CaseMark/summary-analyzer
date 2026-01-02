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
    // STEP 2: Find the PDF report document
    // =========================================================================
    log('info', `Step 2: Finding WORKFLOW_REPORT PDF...`);
    
    // Documents include: WORKFLOW_INPUT, WORKFLOW_RESULT, WORKFLOW_REPORT
    // We want WORKFLOW_REPORT with PDF mime type
    interface WorkflowDocument {
      id: string;
      type: string;
      mimeType: string;
      filename?: string;
    }
    
    let pdfDoc: WorkflowDocument | null = null;
    
    // First try to find WORKFLOW_REPORT with PDF
    for (const doc of documents as WorkflowDocument[]) {
      if (doc.type === 'WORKFLOW_REPORT' && doc.mimeType === 'application/pdf') {
        pdfDoc = doc;
        break;
      }
    }
    
    // Fallback: try any PDF document
    if (!pdfDoc) {
      for (const doc of documents as WorkflowDocument[]) {
        if (doc.mimeType === 'application/pdf') {
          pdfDoc = doc;
          log('warn', `Using fallback PDF document (type: ${doc.type})`);
          break;
        }
      }
    }
    
    // Fallback: try WORKFLOW_RESULT
    if (!pdfDoc) {
      for (const doc of documents as WorkflowDocument[]) {
        if (doc.type === 'WORKFLOW_RESULT') {
          pdfDoc = doc;
          log('warn', `Using WORKFLOW_RESULT document (mimeType: ${doc.mimeType})`);
          break;
        }
      }
    }

    if (!pdfDoc) {
      log('error', `No PDF report found`, { 
        availableTypes: documents.map((d: WorkflowDocument) => `${d.type}:${d.mimeType}`) 
      });
      return NextResponse.json(
        { error: `No PDF report found. Available: ${documents.map((d: WorkflowDocument) => d.type).join(', ')}` },
        { status: 404 }
      );
    }

    const docId = pdfDoc.id;
    const filename = pdfDoc.filename || 'summary.pdf';
    log('info', `Found PDF document`, { docId, filename, type: pdfDoc.type });

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
    // STEP 5: Return the presigned URL - client will handle text extraction
    // =========================================================================
    // Server-side extraction was taking 60+ seconds and timing out
    // Instead, return URL and let client extract via separate API calls
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
