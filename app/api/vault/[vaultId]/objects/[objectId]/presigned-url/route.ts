import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';
const API_KEY = process.env.CASE_API_KEY || '';

/**
 * GET /api/vault/[vaultId]/objects/[objectId]/presigned-url
 * Get a presigned download URL for a vault object
 * 
 * Note: The Case.dev API uses POST for presigned-url with operation in body
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ vaultId: string; objectId: string }> }
) {
  try {
    const { vaultId, objectId } = await params;

    if (!API_KEY) {
      return NextResponse.json(
        { error: 'API key not configured' },
        { status: 500 }
      );
    }

    console.log(`[Vault] Getting presigned URL for ${vaultId}/${objectId}`);

    // Call Case.dev API to get presigned download URL
    // The Case.dev API uses POST with operation in body
    const response = await fetch(
      `${API_BASE_URL}/vault/${vaultId}/objects/${objectId}/presigned-url`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'GET',
          expiresIn: 3600, // 1 hour
        }),
      }
    );

    // Get response as text first to see what we're dealing with
    const responseText = await response.text();
    
    if (!response.ok) {
      console.error(`[Vault] Failed to get presigned URL: ${response.status}`, responseText.substring(0, 500));
      return NextResponse.json(
        { error: `Failed to get download URL: ${responseText.substring(0, 200)}` },
        { status: response.status }
      );
    }

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error(`[Vault] Response is not JSON. First 100 chars:`, responseText.substring(0, 100));
      console.error(`[Vault] Content-Type was:`, response.headers.get('content-type'));
      return NextResponse.json(
        { error: `API returned non-JSON response. Content-Type: ${response.headers.get('content-type')}` },
        { status: 500 }
      );
    }
    
    console.log(`[Vault] Got presigned URL for ${objectId}:`, data.presignedUrl?.substring(0, 80));

    // Return the presigned URL in a consistent format
    return NextResponse.json({ 
      url: data.presignedUrl,
      expiresAt: data.expiresAt,
      filename: data.filename,
    });
  } catch (error) {
    console.error('[Vault] Error getting presigned URL:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

