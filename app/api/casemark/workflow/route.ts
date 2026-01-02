import { NextRequest, NextResponse } from 'next/server';

const CASEMARK_API_URL = process.env.CASEMARK_API_URL || 'https://api-staging.casemarkai.com';
const CASEMARK_API_KEY = process.env.CASEMARK_API_KEY || '';

function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [CaseMark]`;
  
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}`, data ?? '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️ ${message}`, data ?? '');
  } else {
    console.log(`${prefix} ✓ ${message}`, data ?? '');
  }
}

/**
 * Get the document category for CaseMark
 * Valid values: WORKFLOW_INPUT, WORKFLOW_RESULT, WORKFLOW_REPORT, or 1, 2, 3
 * For uploading documents to be processed, use WORKFLOW_INPUT
 */
function getDocumentCategory(): string {
  return 'WORKFLOW_INPUT';
}

/**
 * Step 1: Upload a document to CaseMark and get a documentId
 */
async function uploadDocumentToCaseMark(documentUrl: string, filename: string): Promise<string> {
  log('info', `Step 1: Downloading document from URL...`, { url: documentUrl.substring(0, 80) + '...' });
  
  // Download the document from the presigned URL
  const downloadResponse = await fetch(documentUrl);
  if (!downloadResponse.ok) {
    throw new Error(`Failed to download document: ${downloadResponse.status}`);
  }
  
  const documentBuffer = await downloadResponse.arrayBuffer();
  const contentType = downloadResponse.headers.get('content-type') || 'application/pdf';
  log('info', `Downloaded document`, { size: `${(documentBuffer.byteLength / 1024).toFixed(1)} KB`, contentType });
  
  // Upload to CaseMark
  const category = getDocumentCategory();
  log('info', `Step 2: Uploading to CaseMark...`, { category });
  const formData = new FormData();
  const blob = new Blob([documentBuffer], { type: contentType });
  formData.append('file', blob, filename);
  formData.append('category', category);  // Required field for CaseMark
  
  const uploadResponse = await fetch(`${CASEMARK_API_URL}/api/v1/documents`, {
    method: 'POST',
    headers: {
      'X-API-Key': CASEMARK_API_KEY,
    },
    body: formData,
  });
  
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload to CaseMark: ${uploadResponse.status} - ${errorText}`);
  }
  
  const uploadData = await uploadResponse.json();
  const documentId = uploadData.id || uploadData.data?.id;
  
  if (!documentId) {
    throw new Error(`No document ID returned from CaseMark upload: ${JSON.stringify(uploadData)}`);
  }
  
  log('info', `✅ Document uploaded to CaseMark`, { documentId });
  return documentId;
}

/**
 * Map workflow type to the correct input type for CaseMark
 */
function getInputType(workflowType: string): string {
  if (workflowType.includes('DEPOSITION')) return 'deposition_summary';
  if (workflowType.includes('MEDICAL')) return 'medical_records';
  if (workflowType.includes('HEARING')) return 'hearing_summary';
  if (workflowType.includes('TRIAL')) return 'trial_summary';
  if (workflowType.includes('ARBITRATION')) return 'arbitration_summary';
  if (workflowType.includes('EXHIBIT')) return 'exhibit_list';
  return 'document_ids';
}

/**
 * POST /api/casemark/workflow
 * Create a CaseMark workflow to generate a summary
 * 
 * Two-step process:
 * 1. Upload document to CaseMark to get documentId
 * 2. Create workflow with documentId in inputs object
 */
export async function POST(request: NextRequest) {
  try {
    if (!CASEMARK_API_KEY) {
      log('error', 'CASEMARK_API_KEY not configured');
      return NextResponse.json(
        { error: 'CaseMark API not configured. Set CASEMARK_API_KEY environment variable.' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { workflowType, documentUrls, name, model } = body;

    log('info', `═══════════════════════════════════════════════════════════════`);
    log('info', `🚀 Creating CaseMark workflow (2-step process)`, { 
      workflowType, 
      model, 
      documentCount: documentUrls?.length,
      name,
    });

    if (!workflowType || !documentUrls || documentUrls.length === 0) {
      return NextResponse.json(
        { error: 'workflowType and documentUrls are required' },
        { status: 400 }
      );
    }

    const startTime = Date.now();
    
    // Step 1: Upload each document to CaseMark and collect documentIds
    const documentIds: string[] = [];
    for (let i = 0; i < documentUrls.length; i++) {
      const url = documentUrls[i];
      // Extract filename from URL or use default
      let filename = 'document.pdf';
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart && lastPart.includes('.')) {
          filename = decodeURIComponent(lastPart);
        }
      } catch {
        // Use default filename
      }
      
      log('info', `Uploading document ${i + 1}/${documentUrls.length}: ${filename}`);
      const documentId = await uploadDocumentToCaseMark(url, filename);
      documentIds.push(documentId);
    }
    
    const uploadDuration = Date.now() - startTime;
    log('info', `✅ All documents uploaded in ${uploadDuration}ms`, { documentIds });
    
    // Step 2: Create workflow with documentIds in inputs object
    // This is the exact format that works with appendPageLine and appendTranscript
    
    // If model is 'casemark/default', don't specify a model - use CaseMark's production default
    const useDefaultModel = !model || model === 'casemark/default';
    
    const requestPayload = {
      workflowType,
      ...(name && { name }),
      ...(!useDefaultModel && { model }), // Only include model if NOT using default
      inputs: {
        type: getInputType(workflowType),
        documentIds,                            // ✅ Document IDs from upload
        appendPageLine: true,                   // ✅ Include page/line hyperlinks in output
        appendTranscript: true,                 // ✅ Append original transcript to output PDF
        pageLineSummaryDensity: 'PAGE_LINE_10_1', // ✅ Summary density (10:1 ratio)
      },
    };
    
    if (useDefaultModel) {
      log('info', `🎯 Using CaseMark default model (no model specified in request)`);
    }

    // Log the FULL API request for debugging
    log('info', `═══════════════════════════════════════════════════════════════`);
    log('info', `📦 Creating workflow with inputs:`, JSON.stringify(requestPayload, null, 2));
    log('info', `═══════════════════════════════════════════════════════════════`);
    
    const response = await fetch(`${CASEMARK_API_URL}/api/v1/workflows`, {
      method: 'POST',
      headers: {
        'X-API-Key': CASEMARK_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    const totalDuration = Date.now() - startTime;
    
    if (!response.ok) {
      const errorText = await response.text();
      log('error', `CaseMark API error (${response.status}) in ${totalDuration}ms`, { 
        status: response.status, 
        error: errorText 
      });
      return NextResponse.json(
        { error: `CaseMark API error: ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    log('info', `✅ CaseMark workflow created in ${totalDuration}ms`, { 
      workflowId: data.data?.id,
      status: data.data?.status,
      uploadTime: `${uploadDuration}ms`,
      workflowCreateTime: `${totalDuration - uploadDuration}ms`,
    });

    return NextResponse.json(data);
  } catch (error) {
    log('error', 'Failed to create CaseMark workflow', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

