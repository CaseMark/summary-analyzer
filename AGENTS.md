---
Written by Claude (Opus 4.5) on Dec 30, 2025
Updated: Jan 1, 2026
---

# Summary Analyzer Application

A case.dev web application for comparing AI-generated legal document summary quality across multiple LLM models.

## Quick Start

```bash
cd apps/quality-checker && bun install
# Add CASE_API_KEY to .env.local
bun dev  # http://localhost:3050
```

## Architecture Overview

```
apps/quality-checker/
├── app/                    # Next.js App Router
│   ├── layout.tsx          # Root layout with sidebar
│   ├── page.tsx            # Dashboard (matter list)
│   ├── new/                # Create new comparison wizard
│   │   └── page.tsx
│   └── matter/[id]/        # Matter detail/results page
│       └── page.tsx
│
├── components/             # React components
│   ├── ui/                 # UI primitives (button, card, etc.)
│   ├── file-upload.tsx     # File upload dropzone
│   └── theme-provider.tsx  # Theme context
│
├── lib/                    # Utilities
│   ├── case-api.ts         # case.dev API client
│   ├── storage.ts          # LocalStorage persistence
│   ├── types.ts            # TypeScript types & constants
│   └── utils.ts            # Helper functions
│
└── public/                 # Static assets
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS 4 |
| Components | Radix UI + shadcn/ui |
| API | case.dev (Vault, LLM) |
| State | React hooks + LocalStorage |

## Key Files

### lib/types.ts
Contains all TypeScript interfaces and constants:
- `Matter` - Main data model
- `SummaryResult` - Per-model summary output
- `QualityScore` - GPT-5.2 analysis results
- `TEST_MODELS` - Models to test
- `SUMMARY_PROMPTS` - System prompts per type
- `QUALITY_ANALYSIS_PROMPT` - Judge prompt

### lib/case-api.ts
case.dev API wrapper functions:
- `createVault()` - Create storage vault
- `uploadToVault()` - Upload documents
- `createChatCompletion()` - Generate LLM completions
- `calculateCost()` - Compute token costs

### lib/storage.ts
LocalStorage persistence:
- `getMatters()` - List all matters
- `getMatter(id)` - Get single matter
- `saveMatter()` - Save/update matter
- `deleteMatter()` - Remove matter

## Workflow

1. **Create Matter**: User provides name, type, subject, documents
2. **Upload**: Files uploaded to case.dev Vault
3. **Summarize**: Run 5 models in parallel
4. **Analyze**: GPT-5.2 scores each summary
5. **Results**: Display rankings, costs, detailed scores

## Data Model

```typescript
interface Matter {
  id: string;
  name: string;
  vaultId: string | null;
  summaryType: 'deposition' | 'medical';
  status: MatterStatus;
  sourceDocuments: SourceDocument[];
  summaries: Record<string, SummaryResult>;
  qualityScores: Record<string, QualityScore>;
}
```

## Environment Variables

```bash
CASE_API_KEY=sk_case_...  # Required: case.dev API key
NEXT_PUBLIC_CASE_API_URL=https://api.case.dev  # Optional: API URL
```

## Adding Features

### New Model
1. Add to `TEST_MODELS` array in `lib/types.ts`
2. Include pricing info
3. Model will automatically be included in comparisons

### New Quality Criteria
1. Update `QualityScore` interface
2. Update `QUALITY_ANALYSIS_PROMPT`
3. Add to score display in matter detail page

### New Summary Type
1. Add to `SummaryType` union
2. Add prompt to `SUMMARY_PROMPTS`
3. Add icon/styling in UI

## Styling

Uses a sophisticated dark theme:
- Deep navy background (`#0d1117`)
- Gold accents (`#d4a855`)
- Professional legal-tech aesthetic
- Playfair Display for headings
- DM Sans for body text

CSS variables defined in `globals.css` for easy theming.


