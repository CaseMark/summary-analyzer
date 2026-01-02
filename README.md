# Summary Analyzer

Compare AI-generated legal document summaries across multiple LLM models. Evaluate factual accuracy, citation precision, and legal utility.

## Features

- **Multi-Model Comparison**: Test 5 different LLM models simultaneously
  - Google Gemini 2.5 Flash
  - Google Gemini 2.5 Flash Lite
  - Google Gemini 3 Flash
  - OpenAI GPT-4.1 Mini
  - OpenAI GPT-4.1 Nano

- **Quality Analysis**: GPT-5.2 judges each summary on:
  - Factual Accuracy (25% weight)
  - Page/Line Citation Accuracy (20% weight)
  - Relevance (20% weight)
  - Comprehensiveness (15% weight)
  - Legal Utility (20% weight)

- **Two Summary Types**:
  - Deposition Analysis
  - Medical Record Analysis

- **Cost Analysis**: Track tokens, cost, and value per model

## Quick Start

```bash
# Install dependencies
cd apps/quality-checker && bun install

# Set up environment (copy the example and add your API key)
# Create .env.local with:
# CASE_API_KEY=sk_case_your_api_key_here

# Run development server
bun dev  # Runs on http://localhost:3050
```

## From Monorepo Root

```bash
# Run summary analyzer
bun dev:summary-analyzer
```

## Configuration

Create a `.env.local` file with your API keys:

```bash
# Case.dev API (for vault, LLM, and quality analysis)
CASE_API_KEY=sk_case_your_api_key
CASE_API_URL=https://api.case.dev

# CaseMark API (for summary generation - required!)
CASEMARK_API_KEY=cm_test_your_casemark_api_key
CASEMARK_API_URL=https://api-staging.casemarkai.com
```

Get your Case.dev API key from [console.case.dev](https://console.case.dev).
Get your CaseMark API key from [api-staging.casemarkai.com](https://api-staging.casemarkai.com/docs).

## Usage

1. **Create a Comparison** (4-step wizard):
   - **Step 1**: Matter name, summary type, subject name
   - **Step 2**: Upload source documents (transcript, records)
   - **Step 3**: Control Summary (production baseline)
     - Upload an existing production summary, OR
     - Generate via Production API (if configured)
   - **Step 4**: Review and start

2. **Processing**: The app will:
   - Create a vault and upload documents
   - Generate summaries with all test models (on staging)
   - Run quality analysis comparing each to the control
   - Calculate rankings and cost analysis

3. **View Results**:
   - **Control Tab**: View the production baseline summary
   - Rankings by overall quality score
   - Cost analysis with value metrics
   - Detailed scores with strengths/weaknesses
   - Download individual summaries or compare side-by-side

## Tech Stack

- Next.js 16 (App Router)
- Tailwind CSS 4
- Radix UI Components
- case.dev API
- Local Storage for persistence

## Model Pricing

| Model | Input (per 1M) | Output (per 1M) |
|-------|----------------|-----------------|
| Gemini 2.5 Flash | $0.15 | $0.60 |
| Gemini 2.5 Flash Lite | $0.075 | $0.30 |
| Gemini 3 Flash | $0.10 | $0.40 |
| GPT-4.1 Mini | $0.40 | $1.60 |
| GPT-4.1 Nano | $0.10 | $0.40 |
| GPT-5.2 (Judge) | $3.00 | $12.00 |

## API Endpoints Used

### Case.dev API
- `POST /vault` - Create vault for document storage
- `POST /vault/{id}/upload` - Upload file to vault
- `POST /vault/{id}/ingest/{objectId}` - Process document (OCR/text extraction)
- `GET /vault/{id}/objects/{objectId}` - Check processing status
- `GET /vault/{id}/objects/{objectId}/text` - Get extracted text
- `GET /vault/{id}/objects/{objectId}/download` - Get presigned download URL
- `POST /llm/v1/chat/completions` - Quality analysis (raw LLM)

### CaseMark API
- `POST /api/v1/workflows` - Create summary workflow (with model parameter)
- `GET /api/v1/workflows/{id}` - Check workflow status
- `POST /api/v1/workflows/{id}/download-result` - Download completed summary

## Workflow

1. **Document Upload**: PDF uploaded to Case.dev Vault
2. **Text Extraction**: Vault processes document (OCR/text extraction)
3. **Summary Generation**: CaseMark API generates summaries with different models
4. **Quality Analysis**: GPT-5.2 evaluates each summary against source document
5. **Results**: Rankings, cost analysis, and detailed quality scores
