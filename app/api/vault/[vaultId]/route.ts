import { NextResponse } from 'next/server';

const API_KEY = process.env.CASE_API_KEY;
const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ vaultId: string }> }
) {
  const { vaultId } = await params;
  
  if (!API_KEY) {
    console.error('[Vault DELETE] No API key configured');
    return NextResponse.json(
      { error: 'API key not configured' },
      { status: 500 }
    );
  }

  console.log(`[Vault DELETE] Deleting vault ${vaultId}`);

  try {
    const response = await fetch(`${API_BASE_URL}/vault/${vaultId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Vault DELETE] Failed: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `Failed to delete vault: ${response.statusText}`, details: errorText },
        { status: response.status }
      );
    }

    console.log(`[Vault DELETE] Successfully deleted vault ${vaultId}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Vault DELETE] Exception:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}




