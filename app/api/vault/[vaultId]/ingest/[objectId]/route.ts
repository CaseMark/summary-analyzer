import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';
const API_KEY = process.env.CASE_API_KEY || '';

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST /api/vault/:vaultId/ingest/:objectId
 * Proxy to trigger document ingestion (OCR/text extraction)
 * Includes retry logic for transient errors (TransactionConflict)
 */
export async function POST(
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

    console.log(`[Vault/Ingest] Starting ingestion for ${objectId} in vault ${vaultId}`);

    let lastError: string = '';
    let delay = INITIAL_DELAY_MS;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(
        `${API_BASE_URL}/vault/${vaultId}/ingest/${objectId}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
          },
        }
      );

      const data = await response.json();

      if (response.ok) {
        console.log(`[Vault/Ingest] Started on attempt ${attempt}:`, data);
        return NextResponse.json(data);
      }

      // Check if it's a retryable error (TransactionConflict)
      const errorMsg = data.message || JSON.stringify(data);
      const isRetryable = errorMsg.includes('TransactionConflict') || 
                          errorMsg.includes('ConditionalCheckFailed') ||
                          response.status === 500;

      lastError = errorMsg;

      if (isRetryable && attempt < MAX_RETRIES) {
        console.log(`[Vault/Ingest] Attempt ${attempt} failed with retryable error, retrying in ${delay}ms...`, errorMsg);
        await sleep(delay);
        delay *= 2; // Exponential backoff
        continue;
      }

      // Non-retryable error or max retries reached
      console.error(`[Vault/Ingest] Failed after ${attempt} attempts:`, data);
      return NextResponse.json(
        { error: data.message || 'Failed to start ingestion' },
        { status: response.status }
      );
    }

    // Should not reach here, but just in case
    console.error('[Vault/Ingest] Max retries exceeded:', lastError);
    return NextResponse.json(
      { error: `Max retries exceeded: ${lastError}` },
      { status: 500 }
    );
  } catch (error) {
    console.error('[Vault/Ingest] Exception:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
