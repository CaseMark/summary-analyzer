import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';
const API_KEY = process.env.CASE_API_KEY || '';

// Helper to log with timestamp and color
function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [API/upload]`;
  
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}`, data ?? '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️ ${message}`, data ?? '');
  } else {
    console.log(`${prefix} ✓ ${message}`, data ?? '');
  }
}

/**
 * Two-step upload process:
 * 1. POST to Case.dev to get presigned URL
 * 2. PUT file directly to S3
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ vaultId: string }> }
) {
  try {
    const { vaultId } = await params;
    const formData = await request.formData();
    
    // Get file from FormData
    const file = formData.get('file') as File | null;
    
    if (!file) {
      log('error', 'No file provided');
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    
    log('info', `Upload request`, { 
      vaultId, 
      filename: file.name,
      size: file.size,
      type: file.type 
    });

    if (!API_KEY) {
      log('error', 'CASE_API_KEY is not set');
      return NextResponse.json(
        { error: 'Server configuration error: API key not set' },
        { status: 500 }
      );
    }

    // Step 1: Get presigned URL from Case.dev
    const targetUrl = `${API_BASE_URL}/vault/${vaultId}/upload`;
    log('info', `Step 1: Getting presigned URL from ${targetUrl}`);

    const startTime = Date.now();
    const presignedResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/pdf',
        metadata: {
          source: 'quality-checker',
          uploadedAt: new Date().toISOString(),
        },
      }),
    });

    const presignedData = await presignedResponse.json();

    if (!presignedResponse.ok) {
      log('error', `Failed to get presigned URL (${presignedResponse.status})`, { 
        error: presignedData.message || presignedData.error,
        data: presignedData 
      });
      return NextResponse.json(
        { error: presignedData.message || presignedData.error || 'Failed to get upload URL' },
        { status: presignedResponse.status }
      );
    }

    const { objectId, uploadUrl } = presignedData;
    log('info', `Got presigned URL for object ${objectId}`, { 
      uploadUrlPrefix: uploadUrl?.substring(0, 100) + '...' 
    });

    // Step 2: Upload file directly to S3
    log('info', `Step 2: Uploading ${(file.size / 1024).toFixed(0)} KB to S3...`);
    
    const fileBuffer = await file.arrayBuffer();
    
    const s3Response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'application/pdf',
      },
      body: fileBuffer,
    });

    if (!s3Response.ok) {
      const s3Error = await s3Response.text();
      log('error', `S3 upload failed (${s3Response.status})`, { error: s3Error });
      return NextResponse.json(
        { error: `S3 upload failed: ${s3Response.statusText}` },
        { status: s3Response.status }
      );
    }

    const duration = Date.now() - startTime;
    log('info', `Upload complete in ${duration}ms`, { 
      vaultId,
      objectId,
      filename: file.name,
      size: file.size 
    });

    return NextResponse.json({
      objectId,
      filename: file.name,
      size: file.size,
      contentType: file.type,
    });
  } catch (error) {
    log('error', 'Upload exception', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
