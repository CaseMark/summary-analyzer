import { NextRequest, NextResponse } from 'next/server';

const CASEMARK_API_URL = process.env.CASEMARK_API_URL || 'https://api-staging.casemarkai.com';
const CASEMARK_API_KEY = process.env.CASEMARK_API_KEY || '';

/**
 * GET /api/casemark/workflow/[workflowId]/pdf
 * Download and return the actual PDF file from CaseMark (not extracted text)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await params;

    if (!CASEMARK_API_KEY) {
      return NextResponse.json({ error: 'CaseMark API not configured' }, { status: 503 });
    }

    console.log(`[CaseMark PDF] Getting PDF for workflow: ${workflowId}`);

    // Step 1: Get workflow with documents
    const workflowResponse = await fetch(
      `${CASEMARK_API_URL}/api/v1/workflows/${workflowId}?with_documents=true`,
      {
        headers: { 'X-API-Key': CASEMARK_API_KEY },
      }
    );

    if (!workflowResponse.ok) {
      const errorText = await workflowResponse.text();
      console.error(`[CaseMark PDF] Failed to get workflow: ${workflowResponse.status}`, errorText);
      return NextResponse.json(
        { error: `Failed to get workflow: ${workflowResponse.status}` },
        { status: workflowResponse.status }
      );
    }

    const workflowData = await workflowResponse.json();
    const workflow = workflowData.data || workflowData;
    const documents = workflow.documents || [];

    // Step 2: Find the PDF report
    interface WorkflowDocument {
      id: string;
      type: string;
      mimeType: string;
      filename?: string;
    }

    let pdfDoc: WorkflowDocument | null = null;
    for (const doc of documents as WorkflowDocument[]) {
      if (doc.type === 'WORKFLOW_REPORT' && doc.mimeType === 'application/pdf') {
        pdfDoc = doc;
        break;
      }
    }

    if (!pdfDoc) {
      // Try WORKFLOW_RESULT
      for (const doc of documents as WorkflowDocument[]) {
        if (doc.type === 'WORKFLOW_RESULT' && doc.mimeType === 'application/pdf') {
          pdfDoc = doc;
          break;
        }
      }
    }

    if (!pdfDoc) {
      console.error(`[CaseMark PDF] No PDF document found in workflow`);
      return NextResponse.json({ error: 'No PDF found in workflow' }, { status: 404 });
    }

    console.log(`[CaseMark PDF] Found PDF document: ${pdfDoc.id}`);

    // Step 3: Get presigned download URL
    const docResponse = await fetch(
      `${CASEMARK_API_URL}/api/v1/documents/${pdfDoc.id}?with_download_url=true`,
      {
        headers: { 'X-API-Key': CASEMARK_API_KEY },
      }
    );

    if (!docResponse.ok) {
      const errorText = await docResponse.text();
      console.error(`[CaseMark PDF] Failed to get document: ${docResponse.status}`, errorText);
      return NextResponse.json(
        { error: `Failed to get document: ${docResponse.status}` },
        { status: docResponse.status }
      );
    }

    const docData = await docResponse.json();
    const downloadUrl = docData.downloadUrl;

    if (!downloadUrl) {
      console.error(`[CaseMark PDF] No download URL in document response`);
      return NextResponse.json({ error: 'No download URL available' }, { status: 404 });
    }

    console.log(`[CaseMark PDF] Got download URL, fetching PDF...`);

    // Step 4: Download the PDF from S3
    const pdfResponse = await fetch(downloadUrl);

    if (!pdfResponse.ok) {
      console.error(`[CaseMark PDF] Failed to download from S3: ${pdfResponse.status}`);
      return NextResponse.json(
        { error: `Failed to download PDF: ${pdfResponse.status}` },
        { status: pdfResponse.status }
      );
    }

    const pdfBuffer = await pdfResponse.arrayBuffer();
    // Clean filename - remove non-ASCII chars and sanitize
    const rawFilename = pdfDoc.filename || `casemark-summary-${workflowId}.pdf`;
    const filename = rawFilename
      .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII
      .replace(/[<>:"/\\|?*]/g, '_') // Remove invalid chars
      .trim() || `summary-${workflowId}.pdf`;

    console.log(`[CaseMark PDF] Downloaded ${Math.round(pdfBuffer.byteLength / 1024)} KB`);

    // Return the PDF directly
    return new NextResponse(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': pdfBuffer.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('[CaseMark PDF] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

