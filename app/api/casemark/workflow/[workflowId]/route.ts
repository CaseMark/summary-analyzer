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
 * GET /api/casemark/workflow/[workflowId]
 * Check the status of a CaseMark workflow
 */
export async function GET(
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

    log('info', `Checking workflow status`, { workflowId });

    const response = await fetch(`${CASEMARK_API_URL}/api/v1/workflows/${workflowId}`, {
      method: 'GET',
      headers: {
        'X-API-Key': CASEMARK_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';
    
    // Check if CaseMark returned HTML (error page) instead of JSON
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
      log('error', `CaseMark returned non-JSON response`, { 
        workflowId, 
        status: response.status, 
        contentType,
        isHtml,
        preview: text.substring(0, 200) 
      });
      return NextResponse.json(
        { error: isHtml ? `CaseMark API unavailable (returned HTML error page)` : `Invalid response from CaseMark` },
        { status: 502 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      log('error', `Failed to get workflow status`, { workflowId, status: response.status, error: errorText });
      return NextResponse.json(
        { error: `CaseMark API error: ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Log comprehensive workflow info - check both nested and root level status
    const status = data.data?.status || data.status;
    log('info', `Workflow status`, { 
      workflowId, 
      status,
      rawStatus: data.status,
      nestedStatus: data.data?.status,
      result: data.data?.result || data.result,
      completedAt: data.data?.completedAt || data.completedAt,
      // Usage stats
      usage: data.data?.usage || data.usage,
      cost: data.data?.cost || data.cost,
      durationMs: data.data?.durationMs || data.durationMs,
      model: data.data?.model || data.model,
    });

    // If completed, log the full response for debugging
    if (status === 'COMPLETED') {
      log('info', `COMPLETED workflow full response`, data);
    }

    // Normalize the response structure - CaseMark may return {data: {...}} or just {...}
    const normalizedData = data.data ? data : { data: data };

    return NextResponse.json(normalizedData);
  } catch (error) {
    log('error', 'Failed to check workflow status', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

