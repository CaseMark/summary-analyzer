// Core data types for the Summary Analyzer

// All available CaseMark workflow types (V2 versions are preferred!)
// Reference: CASEMARK_COMPLETE_SOLUTION.py
export type SummaryType = 
  // Primary workflow types
  | 'DEPOSITION_ANALYSIS'              // Comprehensive deposition analysis
  | 'MEDICAL_RECORD_ANALYSIS'          // Medical record analysis
  // V2/V3 workflow types (RECOMMENDED)
  | 'DEPOSITION_SUMMARY_NARRATIVE_V2'  // Best for general deposition use
  | 'DEPOSITION_SUMMARY_PAGELINE_V3'   // With page/line citations
  | 'HEARING_SUMMARY_V2'               // Hearing transcripts
  | 'TRIAL_SUMMARY_V2'                 // Trial transcripts
  | 'TRIAL_DAILIES_V2'                 // Daily trial summaries
  | 'MEDICAL_CHRONOLOGY_V2'            // Medical timeline
  | 'MEDICAL_NARRATIVE'                // Medical narrative summary
  | 'ARBITRATION_SUMMARY_V2'           // Arbitration proceedings
  | 'EXHIBIT_LIST';                    // Exhibit list generation

// Human-readable labels and descriptions for each workflow type
export const SUMMARY_TYPE_INFO: Record<SummaryType, { label: string; description: string; icon: 'deposition' | 'medical' | 'file' }> = {
  'DEPOSITION_ANALYSIS': {
    label: 'Deposition Analysis',
    description: 'Comprehensive analysis with key facts, admissions, and credibility assessment',
    icon: 'deposition',
  },
  'MEDICAL_RECORD_ANALYSIS': {
    label: 'Medical Record Analysis',
    description: 'Detailed analysis with diagnoses, treatments, and timeline',
    icon: 'medical',
  },
  'DEPOSITION_SUMMARY_NARRATIVE_V2': {
    label: 'Deposition Summary (Narrative)',
    description: 'Best for general use - narrative-style deposition summary',
    icon: 'deposition',
  },
  'DEPOSITION_SUMMARY_PAGELINE_V3': {
    label: 'Deposition Summary (Page/Line)',
    description: 'Deposition summary with precise page and line citations',
    icon: 'deposition',
  },
  'HEARING_SUMMARY_V2': {
    label: 'Hearing Summary',
    description: 'Summary of hearing transcripts and proceedings',
    icon: 'deposition',
  },
  'TRIAL_SUMMARY_V2': {
    label: 'Trial Summary',
    description: 'Comprehensive trial transcript summary',
    icon: 'deposition',
  },
  'TRIAL_DAILIES_V2': {
    label: 'Trial Dailies',
    description: 'Daily trial proceeding summaries',
    icon: 'deposition',
  },
  'MEDICAL_CHRONOLOGY_V2': {
    label: 'Medical Chronology',
    description: 'Timeline-based medical record summary',
    icon: 'medical',
  },
  'MEDICAL_NARRATIVE': {
    label: 'Medical Narrative',
    description: 'Narrative-style medical record summary',
    icon: 'medical',
  },
  'ARBITRATION_SUMMARY_V2': {
    label: 'Arbitration Summary',
    description: 'Arbitration proceeding summary',
    icon: 'deposition',
  },
  'EXHIBIT_LIST': {
    label: 'Exhibit List',
    description: 'Generate exhibit list from documents',
    icon: 'file',
  },
};

// Primary workflow types shown prominently in UI
export const PRIMARY_SUMMARY_TYPES: SummaryType[] = [
  'DEPOSITION_SUMMARY_PAGELINE_V3',  // Fast - good for testing
  'DEPOSITION_ANALYSIS',
  'MEDICAL_RECORD_ANALYSIS',
];

// All workflow types in preferred order
export const ALL_SUMMARY_TYPES: SummaryType[] = [
  'DEPOSITION_ANALYSIS',
  'MEDICAL_RECORD_ANALYSIS',
  'DEPOSITION_SUMMARY_NARRATIVE_V2',
  'DEPOSITION_SUMMARY_PAGELINE_V3',
  'HEARING_SUMMARY_V2',
  'TRIAL_SUMMARY_V2',
  'TRIAL_DAILIES_V2',
  'MEDICAL_CHRONOLOGY_V2',
  'MEDICAL_NARRATIVE',
  'ARBITRATION_SUMMARY_V2',
  'EXHIBIT_LIST',
];

export type MatterStatus =
  | 'created'
  | 'uploading'
  | 'processing'
  | 'summarizing'
  | 'analyzing'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface SourceDocument {
  id: string;
  filename: string;
  objectId: string;
  content?: string;
  size: number;
  contentType?: string;
  pageCount?: number;       // From vault ingestion
  chunkCount?: number;      // From vault ingestion
  tokenEstimate?: number;   // Estimated tokens (~4 chars per token)
}

export interface SummaryResult {
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  elapsedTimeMs: number;
  costUsd: number;
  createdAt: string;
  status: 'pending' | 'generating' | 'completed' | 'completed_no_download' | 'error';
  error?: string;
  // CaseMark workflow tracking
  casemarkWorkflowId?: string;  // Store workflow ID to check status later
  casemarkStartedAt?: string;   // When we started the workflow
  casemarkStatus?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'ERROR'; // Last known CaseMark status
}

export interface SpecificError {
  type: 'factual' | 'citation' | 'omission' | 'hallucination' | 'misinterpretation';
  severity: 'critical' | 'major' | 'minor';
  summaryExcerpt: string;       // The problematic text from the summary
  sourceReference?: string;     // Where in source document this relates to (e.g., "Page 5, Lines 12-15")
  explanation: string;          // Why this is an error
  correction?: string;          // What it should say (if applicable)
}

export interface CategoryScore {
  score: number;
  rationale: string;            // Why this score was given
  examples?: string[];          // Specific examples supporting the score
}

export interface QualityScore {
  model: string;
  // Detailed category scores with rationale
  factualAccuracy: CategoryScore;
  pageLineAccuracy: CategoryScore;
  appendedTranscriptAccuracy?: CategoryScore;  // NEW: Accuracy of appended transcript
  relevance: CategoryScore;
  comprehensiveness: CategoryScore;
  legalUtility: CategoryScore;
  overallScore: number;               // Standalone quality score (0-100)
  // Lists
  strengths: string[];
  weaknesses: string[];
  // Specific errors for spot-checking (errors vs SOURCE document)
  specificErrors: SpecificError[];
  // Citation verification results
  citationVerification?: {
    totalCitationsChecked: number;
    correctCitations: number;
    incorrectCitations: number;
    unverifiableCitations: number;
    citationErrors: string[];
  };
  // Missing items from SOURCE that should have been included
  missingItems: string[];
  // Control comparison fields (reference comparison, NOT for scoring)
  controlComparison?: {
    summary: string;                  // Brief summary of how test compares to control
    testBetterThanControl: string[];  // Areas where test is MORE accurate than control
    testWorseThanControl: string[];   // Areas where control is more accurate than test
    testIncludesControlMissing: string[]; // Items test captured that control missed
    controlIncludesTestMissing: string[]; // Items control has that test missed
    transcriptComparison?: string;    // How appended transcripts compare
  } | string;  // Allow string for backwards compatibility
  missingFromTest?: string[];      // Deprecated - use controlComparison
  extraInTest?: string[];          // Deprecated - use controlComparison
  // General analysis
  analysisNotes: string;
  recommendation: string;          // Summary recommendation for this model
  // Cost tracking
  costUsd: number;
  costEffectiveness: number;
  // Comparison metrics (calculated)
  vsControlScore?: number;         // Score relative to control: >0 = better, <0 = worse
  valueScore?: number;             // Combined: quality + cost savings benefit
  costSavingsPercent?: number;     // Cost savings vs control (positive = cheaper)
}

// Control summary from production CaseMark
export interface ControlSummary {
  content: string;                    // The extracted/pasted text content
  source: 'uploaded' | 'generated';   // How it was obtained
  generatedAt?: string;               // When it was generated
  filename?: string;                  // Original filename if uploaded
  fileSize?: number;                  // File size in bytes
  notes?: string;                     // Any notes about this control
  tokenCount?: number;                // Estimated token count
  pageCount?: number;                 // Page count from PDF
}

// Uploaded test summary PDF
export interface UploadedTestSummary {
  modelId: string;                    // Which model generated this (from TEST_MODELS)
  modelName: string;                  // Human readable model name
  filename: string;                   // Original PDF filename
  fileSize: number;                   // File size in bytes
  content: string;                    // Extracted text content (via OCR or paste)
  uploadedAt: string;                 // When it was uploaded
  notes?: string;                     // Any notes
}

// Log entry for processing activity
export interface ProcessingLogEntry {
  timestamp: string; // ISO string for serialization
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  detail?: string;
}

export interface Matter {
  id: string;
  name: string;
  vaultId: string | null;
  summaryType: SummaryType;
  status: MatterStatus;
  createdAt: string;
  updatedAt: string;
  sourceDocuments: SourceDocument[];
  // Control summary - the production standard we're comparing against
  controlSummary?: ControlSummary;
  // Which models to test (selected in wizard)
  modelsToTest?: string[];
  // Generated test summaries from API
  summaries: Record<string, SummaryResult>;
  qualityScores: Record<string, QualityScore>;
  error?: string;
  // Persisted processing log
  processingLog?: ProcessingLogEntry[];
}

// Model configuration
// Pricing sourced from Vercel AI Gateway: https://vercel.com/ai-gateway/models
export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  color: string;
  contextWindow?: number;
  maxOutput?: number;
  notes?: string; // Why this model is being tested
  isControl?: boolean; // True for the baseline/control model
}

export const TEST_MODELS: ModelConfig[] = [
  // === CONTROL BASELINE ===
  {
    id: 'casemark/default',
    name: '⭐ Control (Production)',
    provider: 'CaseMark',
    inputPricePer1M: 0.30, // Estimate based on typical production pricing
    outputPricePer1M: 2.50,
    color: '#fbbf24', // amber/gold - special control color
    contextWindow: 1048576,
    maxOutput: 65536,
    notes: 'BASELINE: Current production output - all other models compared against this',
    isControl: true, // Special flag to identify the control
  },
  // === GOOGLE MODELS ===
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'Google',
    inputPricePer1M: 0.30,
    outputPricePer1M: 2.50,
    color: '#3b82f6', // blue
    contextWindow: 1048576,
    maxOutput: 65536,
    notes: 'High-quality multimodal model with large context',
  },
  // === CHEAPER ALTERNATIVES ===
  {
    id: 'google/gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    provider: 'Google',
    inputPricePer1M: 0.15,
    outputPricePer1M: 1.25,
    color: '#06b6d4', // cyan
    contextWindow: 1048576,
    maxOutput: 65536,
    notes: '~50% cheaper than 2.5 Flash - best potential savings',
  },
  {
    id: 'google/gemini-3-flash',
    name: 'Gemini 3 Flash',
    provider: 'Google',
    inputPricePer1M: 0.50,
    outputPricePer1M: 3.00,
    color: '#a855f7', // purple
    contextWindow: 1048576,
    maxOutput: 65536,
    notes: 'Newest Gemini - ~67% MORE expensive but 30% more token efficient',
  },
  {
    id: 'openai/gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    provider: 'OpenAI',
    inputPricePer1M: 0.10,
    outputPricePer1M: 0.40,
    color: '#84cc16', // lime
    contextWindow: 1047576,
    maxOutput: 32768,
    notes: 'Cheapest OpenAI option - ~67% cheaper than 2.5 Flash',
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'OpenAI',
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.60,
    color: '#10b981', // emerald
    contextWindow: 128000,
    maxOutput: 16384,
    notes: 'Budget OpenAI - ~75% cheaper than 2.5 Flash',
  },
  {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 Nano',
    provider: 'OpenAI',
    inputPricePer1M: 0.10,
    outputPricePer1M: 0.40,
    color: '#f97316', // orange
    contextWindow: 1047576,
    maxOutput: 32768,
    notes: 'Latest GPT-5 smallest variant - ultra-cheap with good quality',
  },
];

// Get the control/baseline model for easy reference
export const CONTROL_MODEL = TEST_MODELS.find(m => m.isControl)!;

// Judge model for quality analysis
// Using GPT-5.2 as the evaluation model
export const JUDGE_MODEL: ModelConfig = {
  id: 'openai/gpt-5.2',
  name: 'GPT-5.2',
  provider: 'OpenAI',
  inputPricePer1M: 2.50,
  outputPricePer1M: 10.00,
  color: '#ef4444', // red
  contextWindow: 200000,
  maxOutput: 100000,
};

// Summary type prompts - used for quality analysis context
const DEPOSITION_PROMPT = `You are an expert legal analyst specializing in deposition analysis.
Create a comprehensive deposition analysis that includes:
- Executive Summary
- Key Facts and Admissions with precise page:line citations
- Witness Credibility Assessment
- Chronology of Events
- Important Testimony Highlights
- Potential Impeachment Opportunities
- Contradictions or Inconsistencies
- Recommendations for Follow-up

Format all citations as (Page X, Line Y) or (X:Y-Z) for ranges.
Be thorough, accurate, and focus on information relevant to legal professionals.`;

const MEDICAL_PROMPT = `You are an expert medical-legal analyst specializing in medical record review.
Create a comprehensive medical record analysis that includes:
- Patient Demographics and Case Overview
- Visit-by-Visit Analysis (provider, reason, complaints, exam findings, diagnoses, treatment)
- All Diagnoses with ICD codes where available and clinical significance
- Medical/Surgical History Timeline
- Medications with dosages and treatment effectiveness assessment
- Functional Status Assessment and Progression
- Psychosocial Factors and Impact on Treatment
- Education/Work History and Disability Considerations
- Future Care Recommendations and Prognosis
- Clinical Correlations and Causation Analysis

Include precise page references for all findings.
Be thorough, clinically accurate, and focus on medico-legal relevance.`;

export const SUMMARY_PROMPTS: Record<SummaryType, string> = {
  'DEPOSITION_ANALYSIS': DEPOSITION_PROMPT,
  'MEDICAL_RECORD_ANALYSIS': MEDICAL_PROMPT,
  'DEPOSITION_SUMMARY_NARRATIVE_V2': DEPOSITION_PROMPT,
  'DEPOSITION_SUMMARY_PAGELINE_V3': DEPOSITION_PROMPT,
  'HEARING_SUMMARY_V2': DEPOSITION_PROMPT,
  'TRIAL_SUMMARY_V2': DEPOSITION_PROMPT,
  'TRIAL_DAILIES_V2': DEPOSITION_PROMPT,
  'MEDICAL_CHRONOLOGY_V2': MEDICAL_PROMPT,
  'MEDICAL_NARRATIVE': MEDICAL_PROMPT,
  'ARBITRATION_SUMMARY_V2': DEPOSITION_PROMPT,
  'EXHIBIT_LIST': DEPOSITION_PROMPT,
};

// Quality analysis prompt when NO control summary is available (compare to source only)
export const QUALITY_ANALYSIS_PROMPT_NO_CONTROL = `You are an expert legal document quality analyst. Your task is to evaluate AI-generated summaries of legal documents against the original source material.

EVALUATION CRITERIA (score each 0-100):

1. **Factual Accuracy** (25% weight)
   - Are all stated facts accurate according to the source?
   - Are there any hallucinations or fabricated information?
   - Are quotes accurate when used?

2. **Page/Line Reference Accuracy** (20% weight)
   - Are page and line citations correct and verifiable?
   - Are citations formatted consistently?
   - Do the citations actually correspond to the referenced content?

3. **Relevance** (20% weight)
   - Does the summary focus on legally significant information?
   - Are irrelevant details minimized?
   - Does it capture what matters for the case type?

4. **Comprehensiveness** (15% weight)
   - Does it cover all major topics from the source?
   - Are key admissions, facts, or findings captured?
   - Is the analysis thorough without being redundant?

5. **Legal Utility** (20% weight)
   - Would this be useful to a legal professional?
   - Does it highlight impeachment opportunities, inconsistencies, or key points?
   - Is it organized for practical use?

SUMMARY TYPE: {summary_type_name}

IMPORTANT: For each error you find, provide the EXACT text from the summary so a human reviewer can search for it. Be specific about what's wrong and why.

Respond with a JSON object in this exact format:
{
    "factual_accuracy": {
        "score": <0-100>,
        "rationale": "Detailed explanation of why this score was given",
        "examples": ["Example of accurate fact...", "Example of inaccurate fact..."]
    },
    "page_line_accuracy": {
        "score": <0-100>,
        "rationale": "Detailed explanation of citation accuracy",
        "examples": ["Example of correct citation...", "Example of incorrect citation..."]
    },
    "relevance": {
        "score": <0-100>,
        "rationale": "Explanation of relevance assessment",
        "examples": ["Example of relevant content...", "Example of irrelevant content..."]
    },
    "comprehensiveness": {
        "score": <0-100>,
        "rationale": "Explanation of coverage assessment",
        "examples": ["Key topic covered well...", "Topic that was missed..."]
    },
    "legal_utility": {
        "score": <0-100>,
        "rationale": "Explanation of practical legal value",
        "examples": ["Useful element...", "Missing practical element..."]
    },
    "overall_score": <0-100>,
    "strengths": ["strength 1", "strength 2", ...],
    "weaknesses": ["weakness 1", "weakness 2", ...],
    "specific_errors": [
        {
            "type": "factual|citation|omission|hallucination|misinterpretation",
            "severity": "critical|major|minor",
            "summary_excerpt": "EXACT text from summary containing the error (for easy search)",
            "source_reference": "Where in source document this relates to (e.g., Page 5, Lines 12-15)",
            "explanation": "Why this is an error",
            "correction": "What it should say instead (if applicable)"
        }
    ],
    "missing_items": [
        "Important item from source that was not included in summary"
    ],
    "analysis_notes": "Overall assessment and context",
    "recommendation": "Brief recommendation about using this model for this type of document"
}`;

// Quality analysis prompt when a CONTROL summary IS available
// IMPORTANT: The SOURCE document is the gold standard for accuracy, NOT the control!
// The control is just what we currently produce - it may have its own errors.
export const QUALITY_ANALYSIS_PROMPT = `You are an expert legal document quality analyst. Your task is to evaluate a TEST SUMMARY for accuracy against the ORIGINAL SOURCE DOCUMENT.

CRITICAL CONTEXT - SUMMARY STRUCTURE:
Our summaries have TWO PARTS:
1. **SUMMARY SECTION** (top) - The AI-generated analysis with page/line citations
2. **APPENDED TRANSCRIPT** (bottom) - The ORIGINAL source transcript appended at the end

This structure allows users to verify citations directly within the document. Page/line citations in the SUMMARY section should reference the exact locations in the APPENDED TRANSCRIPT.

CRITICAL: The SOURCE DOCUMENT (transcript/records) is the ONLY standard for factual accuracy. 
The CONTROL SUMMARY is provided for REFERENCE ONLY - it shows what we currently produce, but it may contain its own errors. 
A TEST summary that is MORE accurate than CONTROL is a GOOD thing!

EVALUATION CRITERIA (score each 0-100, based on SOURCE document accuracy):

1. **Factual Accuracy** (25% weight) - VERIFY AGAINST SOURCE
   - Are all stated facts accurate according to the SOURCE document?
   - Are there any hallucinations or fabricated information not in SOURCE?
   - Are quotes accurate when compared to SOURCE?

2. **Page/Line Reference Accuracy** (20% weight) - VERIFY AGAINST APPENDED TRANSCRIPT
   - Are page and line citations correct when checked against the APPENDED TRANSCRIPT?
   - Does the cited page:line actually contain the referenced testimony?
   - Are citations formatted consistently (e.g., "Page 5, Lines 12-15" or "5:12-15")?
   - Can a user navigate to the citation in the appended transcript and find the referenced content?

3. **Appended Transcript Accuracy** (10% weight) - NEW CRITICAL CHECK
   - Is the appended transcript complete and accurate to the original source?
   - Are page numbers and line numbers preserved correctly?
   - Is the transcript formatting readable and usable for citation verification?

4. **Relevance** (15% weight) - BASED ON SOURCE CONTENT
   - Does the summary focus on legally significant information from SOURCE?
   - Are irrelevant details minimized?
   - Does it capture what matters for the case type?

5. **Comprehensiveness** (15% weight) - COVERAGE OF SOURCE
   - Does it cover all major topics from the SOURCE?
   - Are key admissions, facts, or findings from SOURCE captured?
   - Is the analysis thorough without being redundant?

6. **Legal Utility** (15% weight)
   - Would this be useful to a legal professional?
   - Does it highlight impeachment opportunities, inconsistencies, or key points?
   - Is it organized for practical use?
   - Can citations be easily verified against the appended transcript?

SUMMARY TYPE: {summary_type_name}

IMPORTANT INSTRUCTIONS:
- Score based on accuracy to SOURCE, not similarity to CONTROL
- A test summary can score HIGHER than control if it's more accurate to SOURCE
- Note where TEST is actually BETTER than CONTROL (more accurate, more complete)
- Errors = inaccuracies vs SOURCE document (not differences from CONTROL)
- For each error, provide EXACT text so a human can search for it
- VERIFY CITATIONS by checking if they point to correct content in the APPENDED TRANSCRIPT

CONTROL COMPARISON (secondary analysis):
After scoring accuracy to SOURCE, also note how TEST compares to CONTROL:
- Does TEST include important items that CONTROL missed?
- Does TEST fix errors that exist in CONTROL?
- Is TEST structure/organization better or worse than CONTROL?
- Is TEST's appended transcript more complete/accurate than CONTROL's?

Respond with a JSON object in this exact format:
{
    "factual_accuracy": {
        "score": <0-100>,
        "rationale": "How accurate is TEST compared to SOURCE document?",
        "examples": ["Accurate fact from SOURCE...", "Error: stated X but SOURCE says Y..."]
    },
    "page_line_accuracy": {
        "score": <0-100>,
        "rationale": "Are TEST citations correct when verified against the APPENDED TRANSCRIPT?",
        "examples": ["Citation '5:12-15' correctly points to testimony about X in appended transcript...", "Citation '10:5' is incorrect - that line actually says Y..."]
    },
    "appended_transcript_accuracy": {
        "score": <0-100>,
        "rationale": "Is the appended transcript complete, accurate, and usable for citation verification?",
        "examples": ["Transcript includes all pages with correct line numbers...", "Missing pages 20-25...", "Line numbers are offset by 3..."]
    },
    "relevance": {
        "score": <0-100>,
        "rationale": "Does TEST focus on legally important content from SOURCE?",
        "examples": ["Important content captured...", "Irrelevant detail included..."]
    },
    "comprehensiveness": {
        "score": <0-100>,
        "rationale": "How thoroughly does TEST cover the SOURCE content?",
        "examples": ["Key topic covered well...", "Important SOURCE content missed..."]
    },
    "legal_utility": {
        "score": <0-100>,
        "rationale": "How useful is this for legal professionals? Can citations be easily verified?",
        "examples": ["Useful feature...", "Citations are easy to verify in appended transcript...", "Missing practical element..."]
    },
    "overall_score": <0-100>,
    "strengths": ["Strength based on SOURCE accuracy..."],
    "weaknesses": ["Weakness based on SOURCE accuracy..."],
    "specific_errors": [
        {
            "type": "factual|citation|omission|hallucination|misinterpretation|transcript_error",
            "severity": "critical|major|minor",
            "summary_excerpt": "EXACT text from TEST summary containing error",
            "source_reference": "What SOURCE/APPENDED TRANSCRIPT actually says (page/line)",
            "explanation": "Why this is an error vs SOURCE or APPENDED TRANSCRIPT",
            "correction": "What it should say based on SOURCE"
        }
    ],
    "citation_verification": {
        "total_citations_checked": <number>,
        "correct_citations": <number>,
        "incorrect_citations": <number>,
        "unverifiable_citations": <number>,
        "citation_errors": ["Citation '5:10' claims X but transcript shows Y at that location..."]
    },
    "missing_items": [
        "Important item from SOURCE that TEST does not include"
    ],
    "control_comparison": {
        "summary": "How TEST compares to CONTROL (not a quality score, just comparison)",
        "test_better_than_control": ["Areas where TEST is more accurate than CONTROL..."],
        "test_worse_than_control": ["Areas where CONTROL is more accurate than TEST..."],
        "test_includes_control_missing": ["Items TEST has that CONTROL missed from SOURCE..."],
        "control_includes_test_missing": ["Items CONTROL has that TEST missed from SOURCE..."],
        "transcript_comparison": "How does TEST's appended transcript compare to CONTROL's?"
    },
    "analysis_notes": "Overall assessment of TEST accuracy to SOURCE, including citation verifiability",
    "recommendation": "Recommendation for using this model (considering quality, citation accuracy, and comparison to current production)"
}`;


