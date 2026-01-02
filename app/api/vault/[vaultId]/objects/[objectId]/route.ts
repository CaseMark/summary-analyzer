import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';
const API_KEY = process.env.CASE_API_KEY || '';

/**
 * GET /api/vault/:vaultId/objects/:objectId
 * Proxy to get vault object details (includes ingestionStatus)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ vaultId: string; objectId: string }> }
) {
  try {
    const { vaultId, objectId } = await params;

    if (!API_KEY) {
      return NextResponse.json(
        { error: 'Server configuration error: API key not set' },
        { status: 500 }
      );
    }

    const response = await fetch(
      `${API_BASE_URL}/vault/${vaultId}/objects/${objectId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('[Vault/Object] Error:', data);
      return NextResponse.json(
        { error: data.message || 'Failed to get object' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[Vault/Object] Exception:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}


