'use client';

import { useEffect, useState, useCallback, use, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ArrowLeft,
  Download,
  Trophy,
  DollarSign,
  Clock,
  Sparkles,
  CheckCircle2,
  CheckCircle,
  AlertCircle,
  Loader2,
  FileText,
  FileStack,
  TrendingUp,
  Zap,
  BarChart3,
  Target,
  Scale,
  ChevronDown,
  Search,
  Copy,
  RefreshCw,
  Shield,
  ExternalLink,
  Upload,
  Cpu,
  Terminal,
  List,
  XCircle,
  MessageSquare,
  Send,
  Plus,
  Minus,
} from 'lucide-react';
import {
  Matter,
  SummaryResult,
  QualityScore,
  CategoryScore,
  SpecificError,
  ControlSummary,
  TEST_MODELS,
  JUDGE_MODEL,
  // SUMMARY_PROMPTS - REMOVED: Never generate summaries ourselves, only via CaseMark API
  QUALITY_ANALYSIS_PROMPT,
  QUALITY_ANALYSIS_PROMPT_NO_CONTROL,
  SUMMARY_TYPE_INFO,
} from '@/lib/types';
import { getMatter, saveMatter } from '@/lib/storage';
import {
  createVault,
  uploadToVault,
  createChatCompletion,
  calculateCost,
  getVaultPresignedUrl,
  generateCaseMarkSummary,
  checkAndDownloadCaseMarkSummary,
  downloadCaseMarkResult,
  type CaseMarkWorkflowType,
} from '@/lib/case-api';
import { debugLogger } from '@/lib/debug-logger';
import {
  cn,
  formatDuration,
  formatCurrency,
  getScoreColor,
  getScoreLabel,
  getScoreGradient,
} from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';

interface ProcessingStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  progress?: number;
  detail?: string;
}

export default function MatterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldStart = searchParams.get('start') === 'true';
  const { toast } = useToast();

  const [matter, setMatter] = useState<Matter | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [steps, setSteps] = useState<ProcessingStep[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  
  // Live processing stats
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [currentModelStartTime, setCurrentModelStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [totalTokensUsed, setTotalTokensUsed] = useState(0);
  const [totalCostSoFar, setTotalCostSoFar] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<'process' | 'summarize' | 'analyze' | null>(null);
  const [analysisModelId, setAnalysisModelId] = useState<string | null>(null);
  const [justCompletedModelId, setJustCompletedModelId] = useState<string | null>(null);
  const [justAnalyzedModelId, setJustAnalyzedModelId] = useState<string | null>(null);
  const [analyzingModelId, setAnalyzingModelId] = useState<string | null>(null); // For single summary analysis
  const [expandedSummaryId, setExpandedSummaryId] = useState<string | null>(null); // For previewing summaries
  const [isCancelling, setIsCancelling] = useState(false);
  const cancelRequestedRef = useRef(false);
  const activeWorkflowIdsRef = useRef<string[]>([]); // Track active CaseMark workflow IDs for cleanup

  // Processing activity log - use type from types.ts for persistence
  const [processingLog, setProcessingLog] = useState<import('@/lib/types').ProcessingLogEntry[]>([]);
  const [currentActivity, setCurrentActivity] = useState<string>('');
  const [showProcessingLog, setShowProcessingLog] = useState(true); // Default to showing log

  // Chat with Judge state
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Helper to add log entry and persist to matter
  const addLogEntry = (type: import('@/lib/types').ProcessingLogEntry['type'], message: string, detail?: string) => {
    const entry: import('@/lib/types').ProcessingLogEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      detail,
    };
    setProcessingLog(prev => {
      const updated = [...prev, entry];
      // Keep only last 200 entries to avoid localStorage bloat
      const trimmed = updated.slice(-200);
      // Persist to matter
      setMatter(prevMatter => {
        if (prevMatter) {
          const updatedMatter = { ...prevMatter, processingLog: trimmed };
          saveMatter(updatedMatter);
          return updatedMatter;
        }
        return prevMatter;
      });
      return trimmed;
    });
    if (type !== 'error') {
      setCurrentActivity(message);
    }
  };

  // Cancel processing
  const cancelProcessing = async () => {
    if (!processing && !runningAnalysis) return;
    
    setIsCancelling(true);
    cancelRequestedRef.current = true;
    addLogEntry('warning', 'Cancellation requested...');
    
    // Note: Active CaseMark workflows will continue on their end,
    // but we'll stop polling and not start new ones
    // The workflow results will be orphaned but won't cost extra
    
    // Clear active workflow tracking
    const orphanedWorkflows = [...activeWorkflowIdsRef.current];
    if (orphanedWorkflows.length > 0) {
      addLogEntry('info', `Abandoning ${orphanedWorkflows.length} in-progress workflow(s)`);
    }
    activeWorkflowIdsRef.current = [];
    
    // Update matter status to indicate cancellation
    if (matter) {
      const updatedMatter = {
        ...matter,
        status: 'cancelled' as const,
        error: 'Processing cancelled by user',
        updatedAt: new Date().toISOString(),
      };
      saveMatter(updatedMatter);
      setMatter(updatedMatter);
    }
    
    // Reset processing state
    setProcessing(false);
    setRunningAnalysis(false);
    setCurrentPhase(null);
    setCurrentActivity('');
    setCurrentModelId(null);
    setCurrentModelStartTime(null);
    
    addLogEntry('warning', 'Processing cancelled');
    toast({
      title: 'Processing Cancelled',
      description: 'The current run has been stopped. Any completed summaries are preserved.',
    });
    
    setIsCancelling(false);
  };

  // Document processing status
  interface DocProcessingStatus {
    filename: string;
    type: 'source' | 'control';
    status: 'pending' | 'uploading' | 'processing' | 'extracting' | 'completed' | 'error';
    detail?: string;
    progress?: number;
    size?: number;
    pageCount?: number;
    charCount?: number;
    startTime?: number;
  }
  const [docProcessingStatus, setDocProcessingStatus] = useState<DocProcessingStatus[]>([]);

  // Load matter
  useEffect(() => {
    const m = getMatter(id);
    if (m) {
      setMatter(m);
      // Load persisted processing log
      if (m.processingLog && m.processingLog.length > 0) {
        setProcessingLog(m.processingLog);
        // Set current activity to last non-error message
        const lastActivity = [...m.processingLog].reverse().find(e => e.type !== 'error');
        if (lastActivity) {
          setCurrentActivity(lastActivity.message);
        }
      }
      // Initialize steps based on status
      const modelsCount = m.modelsToTest?.length || TEST_MODELS.length;
      if (m.status === 'completed') {
        setSteps([
          { id: 'process', label: 'Process Documents', status: 'completed' },
          { id: 'summarize', label: `Generate Summaries (${modelsCount} models)`, status: 'completed' },
          { id: 'analyze', label: 'Quality Analysis', status: 'completed' },
        ]);
      }
    }
    setLoading(false);
  }, [id]);

  // Start processing if needed
  useEffect(() => {
    // Allow starting if:
    // 1. URL has ?start=true (shouldStart)
    // 2. Matter exists
    // 3. Not already processing in this session
    // 4. Matter status allows it (created, processing, or analyzing but not completed)
    const canStart = shouldStart && matter && !processing && matter.status !== 'completed';
    
    if (canStart) {
      console.log('[StartProcessing] Starting processing...', {
        matterStatus: matter.status,
        shouldStart,
        processing,
        existingSummaries: Object.keys(matter.summaries || {}).length,
      });
      startProcessing();
    } else if (shouldStart && matter) {
      console.log('[StartProcessing] Cannot start - conditions not met:', {
        matterStatus: matter.status,
        shouldStart,
        processing,
        canStart,
      });
    }
  }, [shouldStart, matter, processing]);

  // Live timer for current generation
  useEffect(() => {
    if (!currentModelStartTime) {
      setElapsedSeconds(0);
      return;
    }
    
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - currentModelStartTime) / 1000));
    }, 1000);
    
    return () => clearInterval(interval);
  }, [currentModelStartTime]);

  const updateStep = (stepId: string, updates: Partial<ProcessingStep>) => {
    setSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, ...updates } : s))
    );
  };

  const updateMatter = (updates: Partial<Matter>) => {
    setMatter(prevMatter => {
      if (!prevMatter) return prevMatter;
      const updated = { ...prevMatter, ...updates, updatedAt: new Date().toISOString() };
      saveMatter(updated);
      return updated;
    });
  };

  // Track which models are currently being retried
  const [retryingModels, setRetryingModels] = useState<Set<string>>(new Set());
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  
  // Track analysis progress more granularly
  const [extractingModels, setExtractingModels] = useState<Set<string>>(new Set());
  const [analyzingModels, setAnalyzingModels] = useState<Set<string>>(new Set());
  const [analysisProgress, setAnalysisProgress] = useState<{ current: number; total: number; currentModel: string } | null>(null);

  // Retry a single model's summary - MUST use CaseMark API, never raw LLM
  const retrySingleModel = async (modelId: string) => {
    if (!matter) return;
    
    const model = TEST_MODELS.find(m => m.id === modelId);
    if (!model) return;

    setRetryingModels(prev => new Set([...prev, modelId]));
    addLogEntry('info', `Retrying ${model.name} via CaseMark API...`);

    const startTime = Date.now();

    try {
      // CRITICAL: We MUST use CaseMark API for summaries - never raw LLM calls
      // First, get the presigned URL for the source document
      const sourceDoc = matter.sourceDocuments[0];
      if (!sourceDoc?.objectId || !matter.vaultId) {
        throw new Error('No source document or vault ID - cannot call CaseMark API');
      }

      const urlResult = await getVaultPresignedUrl(matter.vaultId, sourceDoc.objectId);
      if (urlResult.error || !urlResult.data?.url) {
        throw new Error(`Failed to get document URL: ${urlResult.error}`);
      }

      const documentUrl = urlResult.data.url;
      // summaryType IS the CaseMark workflow type now (e.g., 'DEPOSITION_ANALYSIS')
      const workflowType: CaseMarkWorkflowType = matter.summaryType;

      addLogEntry('info', `Calling CaseMark ${workflowType} with ${model.name}...`);

      // Call CaseMark API - this is the ONLY way to generate summaries
      const result = await generateCaseMarkSummary(
        workflowType,
        [documentUrl],
        model.id,
        `${matter.name} - ${model.name} (retry)`,
        (status) => addLogEntry('info', `   └─ ${status}`)
      );

      const elapsedTime = Date.now() - startTime;

      let newSummary: SummaryResult;

      if (result.error || !result.data?.content) {
        newSummary = {
          model: model.id,
          content: '',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          elapsedTimeMs: elapsedTime,
          costUsd: 0,
          createdAt: new Date().toISOString(),
          status: 'error',
          error: result.error || 'CaseMark API returned no content',
          casemarkWorkflowId: result.data?.workflowId,
        };
        addLogEntry('error', `${model.name} failed: ${result.error}`);
      } else {
        // Estimate tokens from content length (~4 chars per token)
        const estimatedTokens = Math.ceil(result.data.content.length / 4);
        const cost = calculateCost(
          estimatedTokens,
          estimatedTokens,
          model.inputPricePer1M,
          model.outputPricePer1M
        );

        // Use actual API stats if available, otherwise estimate
        const hasActualStats = !!(result.data.inputTokens && result.data.outputTokens && result.data.costUsd);
        const statsEstimated = !hasActualStats;
        
        if (statsEstimated) {
          addLogEntry('warning', `⚠️ ${model.name}: Using estimated stats (API didn't return actual usage)`);
        }
        
        newSummary = {
          model: model.id,
          content: result.data.content,
          inputTokens: result.data.inputTokens || estimatedTokens,
          outputTokens: result.data.outputTokens || estimatedTokens,
          totalTokens: result.data.totalTokens || (estimatedTokens * 2),
          elapsedTimeMs: elapsedTime,
          costUsd: result.data.costUsd || cost,
          createdAt: new Date().toISOString(),
          status: 'completed',
          casemarkWorkflowId: result.data.workflowId,
          statsEstimated,
        };
        addLogEntry('success', `${model.name} completed via CaseMark`, `${(elapsedTime / 1000).toFixed(1)}s • ${statsEstimated ? '~' : ''}$${newSummary.costUsd.toFixed(4)}`);
        
        toast({
          title: 'Summary generated',
          description: `${model.name} completed via CaseMark API`,
        });
      }

      // Update matter with new summary
      const updatedSummaries = { ...matter.summaries, [model.id]: newSummary };
      updateMatter({ summaries: updatedSummaries });

    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      addLogEntry('error', `${model.name} failed: ${errorMsg}`);
      
      const newSummary: SummaryResult = {
        model: model.id,
        content: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        elapsedTimeMs: elapsedTime,
        costUsd: 0,
        createdAt: new Date().toISOString(),
        status: 'error',
        error: errorMsg,
      };
      const updatedSummaries = { ...matter.summaries, [model.id]: newSummary };
      updateMatter({ summaries: updatedSummaries });
      
      toast({
        title: 'Summary failed',
        description: errorMsg,
        variant: 'destructive',
      });
    } finally {
      setRetryingModels(prev => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  };

  // Retry all failed models
  const retryAllFailed = async () => {
    if (!matter) return;
    
    const failedModels = TEST_MODELS.filter(
      m => !matter.summaries[m.id] || matter.summaries[m.id].status === 'error'
    );

    for (const model of failedModels) {
      await retrySingleModel(model.id);
    }
  };

  // Check status of a workflow that may have completed after we lost connection
  // FAST: Just checks status, doesn't download or extract text
  const checkWorkflowStatus = async (modelId: string) => {
    console.log(`[CHECK] checkWorkflowStatus called for ${modelId}`);
    
    if (!matter) {
      console.log(`[CHECK] No matter object`);
      return;
    }
    
    const summary = matter.summaries[modelId];
    if (!summary?.casemarkWorkflowId) {
      console.log(`[CHECK] No workflow ID for ${modelId}`);
      toast({
        title: 'No workflow ID',
        description: 'Cannot check status - no workflow ID saved.',
        variant: 'destructive',
      });
      return;
    }
    
    const model = TEST_MODELS.find(m => m.id === modelId);
    const workflowId = summary.casemarkWorkflowId;
    
    console.log(`[CHECK] Checking ${model?.name || modelId} workflow ${workflowId}`);
    
    setRetryingModels(prev => new Set(prev).add(modelId));
    addLogEntry('info', `🔍 Checking ${model?.name || modelId}...`);

    try {
      // FAST: Just check status - skip slow text extraction
      const result = await checkAndDownloadCaseMarkSummary(
        workflowId,
        (status) => {
          console.log(`[CHECK] ${model?.name}: ${status}`);
          addLogEntry('info', `   └─ ${status}`);
        },
        true // skipDownload = true for instant check!
      );
      
      console.log(`[CHECK] Result for ${model?.name}:`, result.data?.casemarkStatus, result.error);
      
      // Check if CaseMark workflow completed (even if download failed)
      const casemarkCompleted = result.data?.casemarkStatus === 'COMPLETED';
      // Note: '[CONTENT_NOT_EXTRACTED]' is a placeholder returned when skipDownload=true
      const hasContent = result.data?.content && 
                        result.data.content.length > 0 && 
                        result.data.content !== '[CONTENT_NOT_EXTRACTED]';
      
      // Log what we found
      addLogEntry('info', `   └─ Status: ${result.data?.casemarkStatus || 'UNKNOWN'} | Content: ${hasContent ? 'Yes' : 'No'}`);
      
      if (!casemarkCompleted && !result.error) {
        // Still running - show clear feedback
        addLogEntry('info', `   └─ ⏳ ${model?.name || modelId}: Still RUNNING on CaseMark`);
        toast({
          title: 'Still processing',
          description: `${model?.name || modelId} is still running on CaseMark. Check back in a minute.`,
        });
        setRetryingModels(prev => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
        return;
      }
      
      if (!casemarkCompleted && result.error) {
        // Error or not started
        addLogEntry('error', `   └─ ❌ ${model?.name || modelId}: ${result.error}`);
        toast({
          title: 'Error',
          description: result.error || 'Failed to check status.',
          variant: 'destructive',
        });
        setRetryingModels(prev => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
        return;
      }
      
      if (casemarkCompleted && !hasContent) {
        // CaseMark finished but we didn't download the file (because skipDownload=true)
        addLogEntry('success', `   └─ ${model?.name || modelId}: COMPLETED ✓ (ready to download)`);
        
        const updatedSummary: SummaryResult = {
          ...summary,
          status: 'completed_no_download',
          casemarkStatus: 'COMPLETED',
          error: result.error || 'Download failed',
        };
        
        setMatter(prev => {
          if (!prev) return prev;
          const updated = {
            ...prev,
            summaries: { ...prev.summaries, [modelId]: updatedSummary },
            updatedAt: new Date().toISOString(),
          };
          saveMatter(updated);
          return updated;
        });
        
        toast({
          title: 'CaseMark completed!',
          description: `${model?.name || modelId} finished on CaseMark but download failed. Click "Download" to try again.`,
        });
        return;
      }
      
      // Success! We have content
      const estimatedTokens = Math.ceil(result.data!.content.length / 4);
      const costUsd = model ? calculateCost(
        estimatedTokens,
        estimatedTokens,
        model.inputPricePer1M,
        model.outputPricePer1M
      ) : 0;
      
      const updatedSummary: SummaryResult = {
        model: modelId,
        content: result.data!.content,
        inputTokens: estimatedTokens,
        outputTokens: estimatedTokens,
        totalTokens: estimatedTokens * 2,
        elapsedTimeMs: result.data!.elapsedMs,
        costUsd,
        createdAt: summary.casemarkStartedAt || new Date().toISOString(),
        status: 'completed',
        casemarkWorkflowId: workflowId,
        casemarkStatus: 'COMPLETED',
      };
      
      setMatter(prev => {
        if (!prev) return prev;
        const updated = {
          ...prev,
          summaries: { ...prev.summaries, [modelId]: updatedSummary },
          updatedAt: new Date().toISOString(),
        };
        saveMatter(updated);
        return updated;
      });
      
      addLogEntry('success', `${model?.name || modelId} recovered successfully!`, `${(result.data!.elapsedMs / 1000).toFixed(1)}s`);
      
      toast({
        title: 'Summary recovered!',
        description: `${model?.name || modelId} is now complete.`,
      });
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      addLogEntry('error', `Check status failed: ${errorMsg}`);
      toast({
        title: 'Check failed',
        description: errorMsg,
        variant: 'destructive',
      });
    } finally {
      setRetryingModels(prev => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  };

  // Refresh all stuck jobs - check status and download any completed summaries
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<{ current: number; total: number; modelName: string } | null>(null);
  
  const refreshAllJobs = async () => {
    if (!matter || refreshingAll) return;
    
    setRefreshingAll(true);
    setRefreshProgress({ current: 0, total: 0, modelName: 'Starting...' });
    addLogEntry('info', '🔄 REFRESH ALL: Checking all jobs and downloading completed summaries...');
    
    toast({
      title: 'Refreshing All Jobs',
      description: 'Checking status and downloading completed summaries...',
      duration: 3000,
    });
    
    const selectedModels = matter.modelsToTest 
      ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
      : TEST_MODELS;
    
    let downloadedCount = 0;
    let stillRunningCount = 0;
    let errorCount = 0;
    let alreadyDoneCount = 0;
    
    setRefreshProgress({ current: 0, total: selectedModels.length, modelName: 'Checking...' });
    
    try {
      for (let i = 0; i < selectedModels.length; i++) {
        const model = selectedModels[i];
        const summary = matter.summaries[model.id];
        
        // Update progress
        setRefreshProgress({ current: i + 1, total: selectedModels.length, modelName: model.name });
        
        // Skip if no workflow ID
        if (!summary?.casemarkWorkflowId) {
          addLogEntry('info', `   ⏭️ ${model.name}: No workflow ID, skipping`);
          continue;
        }
        
        // Check if already fully downloaded with content
        const hasContent = summary.content && summary.content.length > 100;
        if (summary.status === 'completed' && hasContent) {
          alreadyDoneCount++;
          addLogEntry('info', `   ✓ ${model.name}: Already downloaded (${summary.content.length.toLocaleString()} chars)`);
          continue;
        }
        
        // NEEDS CHECK: ANY summary that isn't fully downloaded - including errors!
        // The summary might have completed on CaseMark even if our download timed out
        const needsDownload = 
          summary.status === 'completed_no_download' || 
          summary.status === 'error' ||  // ← ALSO check errored summaries!
          summary.status === 'generating' ||  // ← Check if still generating
          summary.casemarkStatus === 'COMPLETED' ||
          !hasContent;  // ← Any summary without content
        
        if (needsDownload) {
          // Step 1: Check status on CaseMark first
          addLogEntry('info', `🔍 ${model.name}: Checking CaseMark status...`);
          setRefreshProgress({ current: i + 1, total: selectedModels.length, modelName: `Checking ${model.name}...` });
          
          let workflowDurationMs = summary.elapsedTimeMs || 0;
          let actualCost = summary.costUsd || 0;
          let actualInputTokens = summary.inputTokens || 0;
          let actualOutputTokens = summary.outputTokens || 0;
          let casemarkStatus = summary.casemarkStatus;
          
          try {
            const statusResult = await checkAndDownloadCaseMarkSummary(summary.casemarkWorkflowId, undefined, true);
            if (statusResult.data) {
              casemarkStatus = statusResult.data.casemarkStatus;
              workflowDurationMs = statusResult.data.casemarkDurationMs || statusResult.data.elapsedMs || workflowDurationMs;
              actualCost = statusResult.data.costUsd || actualCost;
              actualInputTokens = statusResult.data.inputTokens || actualInputTokens;
              actualOutputTokens = statusResult.data.outputTokens || actualOutputTokens;
            }
          } catch (e) {
            addLogEntry('warning', `   └─ ${model.name}: Status check failed - ${e}`);
          }
          
          // If not completed on CaseMark, skip download
          if (casemarkStatus !== 'COMPLETED') {
            addLogEntry('info', `   └─ ${model.name}: Status = ${casemarkStatus || 'UNKNOWN'} (not ready)`);
            if (casemarkStatus === 'RUNNING' || casemarkStatus === 'QUEUED') {
              stillRunningCount++;
            }
            continue;
          }
          
          // Log that CaseMark summary is ready with timing
          const timeStr = workflowDurationMs > 0 ? ` (${(workflowDurationMs / 1000).toFixed(1)}s)` : '';
          addLogEntry('success', `📋 ${model.name}: COMPLETED on CaseMark${timeStr}`);
          
          // Step 2: Start download
          setRefreshProgress({ current: i + 1, total: selectedModels.length, modelName: `Downloading ${model.name}...` });
          addLogEntry('info', `📥 ${model.name}: Downloading PDF...`);
          
          try {
            const downloadResult = await Promise.race([
              downloadCaseMarkResult(summary.casemarkWorkflowId, 'PDF'),
              new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('Download timeout (5 min)')), 300000)
              )
            ]);
            
            if (downloadResult.data && downloadResult.data.length > 100) {
              const content = downloadResult.data;
              const hasActualStats = actualInputTokens > 0 && actualCost > 0;
              const estimatedTokens = Math.ceil(content.length / 4);
              const estimatedCost = calculateCost(estimatedTokens, estimatedTokens, model.inputPricePer1M, model.outputPricePer1M);
              
              setMatter(prev => {
                if (!prev) return prev;
                const updatedSummaries = {
                  ...prev.summaries,
                  [model.id]: {
                    ...prev.summaries[model.id],
                    content,
                    status: 'completed' as const,
                    casemarkStatus: 'COMPLETED' as const,
                    elapsedTimeMs: workflowDurationMs,
                    inputTokens: hasActualStats ? actualInputTokens : estimatedTokens,
                    outputTokens: hasActualStats ? actualOutputTokens : estimatedTokens,
                    totalTokens: hasActualStats ? (actualInputTokens + actualOutputTokens) : estimatedTokens * 2,
                    costUsd: hasActualStats ? actualCost : estimatedCost,
                    statsEstimated: !hasActualStats,
                  },
                };
                const updated = { ...prev, summaries: updatedSummaries, updatedAt: new Date().toISOString() };
                saveMatter(updated);
                return updated;
              });
              
              downloadedCount++;
              // Step 3: Log extraction complete with timing
              const costStr = hasActualStats ? `$${actualCost.toFixed(4)}` : `~$${estimatedCost.toFixed(4)}`;
              addLogEntry('success', `✅ ${model.name}: ${content.length.toLocaleString()} chars | ${costStr} | ${(workflowDurationMs / 1000).toFixed(1)}s`);
            } else {
              addLogEntry('warning', `⚠️ ${model.name}: Download returned empty/small content`);
              errorCount++;
            }
          } catch (dlError) {
            const errorMsg = dlError instanceof Error ? dlError.message : 'Unknown error';
            addLogEntry('error', `❌ ${model.name}: Download failed - ${errorMsg}`);
            errorCount++;
          }
          continue;
        }
        
        // Check CaseMark status for jobs that might be done
        addLogEntry('info', `🔍 ${model.name}: Checking CaseMark status...`);
        
        try {
          const result = await checkAndDownloadCaseMarkSummary(
            summary.casemarkWorkflowId,
            undefined,
            true // skipDownload for quick status check
          );
          
          const casemarkStatus = result.data?.casemarkStatus;
          
          if (casemarkStatus === 'COMPLETED') {
            // Get timing and cost data from the status result
            const workflowDurationMs = result.data?.casemarkDurationMs || result.data?.elapsedMs || 0;
            const actualCost = result.data?.costUsd || summary.costUsd || 0;
            const actualInputTokens = result.data?.inputTokens || summary.inputTokens || 0;
            const actualOutputTokens = result.data?.outputTokens || summary.outputTokens || 0;
            
            // Step 1: Log with timing
            const timeStr = workflowDurationMs > 0 ? ` (${(workflowDurationMs / 1000).toFixed(1)}s)` : '';
            addLogEntry('success', `📋 ${model.name}: Summary COMPLETED${timeStr}`);
            addLogEntry('info', `📥 ${model.name}: Downloading PDF...`);
            
            try {
              const downloadResult = await Promise.race([
                downloadCaseMarkResult(summary.casemarkWorkflowId, 'PDF'),
                new Promise<never>((_, reject) => 
                  setTimeout(() => reject(new Error('Download timeout')), 300000)
                )
              ]);
              
              if (downloadResult.data && downloadResult.data.length > 100) {
                const content = downloadResult.data;
                const hasActualStats = actualInputTokens > 0 && actualCost > 0;
                const estimatedTokens = Math.ceil(content.length / 4);
                const estimatedCost = calculateCost(estimatedTokens, estimatedTokens, model.inputPricePer1M, model.outputPricePer1M);
                
                setMatter(prev => {
                  if (!prev) return prev;
                  const updatedSummaries = {
                    ...prev.summaries,
                    [model.id]: {
                      ...prev.summaries[model.id],
                      content,
                      status: 'completed' as const,
                      casemarkStatus: 'COMPLETED' as const,
                      elapsedTimeMs: workflowDurationMs,
                      inputTokens: hasActualStats ? actualInputTokens : estimatedTokens,
                      outputTokens: hasActualStats ? actualOutputTokens : estimatedTokens,
                      totalTokens: hasActualStats ? (actualInputTokens + actualOutputTokens) : estimatedTokens * 2,
                      costUsd: hasActualStats ? actualCost : estimatedCost,
                      statsEstimated: !hasActualStats,
                    },
                  };
                  const updated = { ...prev, summaries: updatedSummaries, updatedAt: new Date().toISOString() };
                  saveMatter(updated);
                  return updated;
                });
                
                downloadedCount++;
                // Log with actual stats
                const costStr = hasActualStats ? `$${actualCost.toFixed(4)}` : `~$${estimatedCost.toFixed(4)}`;
                addLogEntry('success', `✅ ${model.name}: ${content.length.toLocaleString()} chars | ${costStr} | ${(workflowDurationMs / 1000).toFixed(1)}s`);
              }
            } catch (dlError) {
              addLogEntry('error', `❌ ${model.name}: Download/extraction failed`);
              // Mark as completed_no_download
              setMatter(prev => {
                if (!prev) return prev;
                const updated = {
                  ...prev,
                  summaries: {
                    ...prev.summaries,
                    [model.id]: { ...prev.summaries[model.id], status: 'completed_no_download' as const, casemarkStatus: 'COMPLETED' as const },
                  },
                  updatedAt: new Date().toISOString(),
                };
                saveMatter(updated);
                return updated;
              });
              errorCount++;
            }
          } else if (casemarkStatus === 'RUNNING' || casemarkStatus === 'QUEUED') {
            stillRunningCount++;
            addLogEntry('info', `⏳ ${model.name}: Still ${casemarkStatus} on CaseMark (waiting...)`);
          } else if (casemarkStatus === 'FAILED') {
            addLogEntry('error', `❌ ${model.name}: Summary FAILED on CaseMark`);
            setMatter(prev => {
              if (!prev) return prev;
              const updated = {
                ...prev,
                summaries: {
                  ...prev.summaries,
                  [model.id]: { ...prev.summaries[model.id], status: 'error' as const, error: 'CaseMark workflow failed', casemarkStatus: 'FAILED' as const },
                },
                updatedAt: new Date().toISOString(),
              };
              saveMatter(updated);
              return updated;
            });
            errorCount++;
          } else {
            addLogEntry('warning', `❓ ${model.name}: Unknown status: ${casemarkStatus}`);
          }
        } catch (error) {
          addLogEntry('warning', `⚠️ ${model.name}: Status check failed`);
        }
      }
      
      // Summary
      const totalProcessed = downloadedCount + stillRunningCount + errorCount + alreadyDoneCount;
      addLogEntry('success', `🔄 REFRESH COMPLETE: ${downloadedCount} downloaded, ${alreadyDoneCount} already done, ${stillRunningCount} still running, ${errorCount} errors`);
      
      toast({
        title: 'Refresh Complete',
        description: `Downloaded ${downloadedCount} summaries${stillRunningCount > 0 ? `, ${stillRunningCount} still running` : ''}${errorCount > 0 ? `, ${errorCount} errors` : ''}`,
        duration: 3000,
      });
      
      // AUTO-START ANALYSIS: If we downloaded any summaries, start quality analysis
      if (downloadedCount > 0 || alreadyDoneCount > 0) {
        const completedWithoutAnalysis = selectedModels.filter(m => {
          const s = matter.summaries[m.id];
          const q = matter.qualityScores[m.id];
          return s?.status === 'completed' && s?.content && s.content.length > 100 && !q;
        });
        
        if (completedWithoutAnalysis.length > 0) {
          addLogEntry('info', `═══════════════════════════════════════════════════`);
          addLogEntry('info', `🤖 AUTO-STARTING QUALITY ANALYSIS`);
          addLogEntry('info', `   ${completedWithoutAnalysis.length} summaries ready for GPT-5.2 evaluation:`);
          completedWithoutAnalysis.forEach((m, idx) => {
            addLogEntry('info', `   ${idx + 1}. ${m.name}`);
          });
          addLogEntry('info', `═══════════════════════════════════════════════════`);
          // Small delay to let state settle, then trigger analysis
          setTimeout(() => {
            runQualityAnalysis();
          }, 500);
        }
      }
      
    } catch (error) {
      addLogEntry('error', `🔄 Refresh failed: ${error instanceof Error ? error.message : 'Error'}`);
      toast({
        title: 'Refresh failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setRefreshingAll(false);
      setRefreshProgress(null);
    }
  };

  // Download and extract content for a completed summary
  const downloadSummaryContent = async (modelId: string) => {
    if (!matter) return;
    
    const summary = matter.summaries[modelId];
    if (!summary?.casemarkWorkflowId) {
      toast({
        title: 'Cannot download',
        description: 'No workflow ID available for this summary.',
        variant: 'destructive',
      });
      return;
    }
    
    const model = TEST_MODELS.find(m => m.id === modelId);
    const modelName = model?.name || modelId;
    const workflowId = summary.casemarkWorkflowId;
    
    setRetryingModels(prev => new Set(prev).add(modelId));
    addLogEntry('info', `📥 Downloading ${modelName}... (this may take a few minutes)`);
    
    try {
      // 5 minute timeout for download + text extraction
      const timeoutMs = 300000;
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Download timeout after ${Math.round(timeoutMs/1000)}s`)), timeoutMs)
      );
      
      const startTime = Date.now();
      
      toast({
        title: 'Downloading...',
        description: `${modelName}: Extracting text from PDF (may take 2-5 minutes)`,
      });
      
      const downloadResult = await Promise.race([
        downloadCaseMarkResult(workflowId, 'PDF'),
        timeoutPromise
      ]);
      
      const elapsed = Date.now() - startTime;
      
      if (downloadResult.error) {
        addLogEntry('error', `${modelName} download failed: ${downloadResult.error}`);
        toast({
          title: 'Download failed',
          description: downloadResult.error,
          variant: 'destructive',
        });
        return;
      }
      
      if (!downloadResult.data || downloadResult.data.length < 100) {
        addLogEntry('error', `${modelName} returned empty or too short content`);
        toast({
          title: 'Download failed',
          description: 'Empty or too short content returned',
          variant: 'destructive',
        });
        return;
      }
      
      // Calculate stats
      const content = downloadResult.data;
      const hasActualStats = !!(summary.inputTokens && summary.inputTokens > 0 && summary.costUsd && summary.costUsd > 0);
      const estimatedTokens = Math.ceil(content.length / 4);
      const estimatedCost = model ? calculateCost(estimatedTokens, estimatedTokens, model.inputPricePer1M, model.outputPricePer1M) : 0;
      
      const updatedSummary: SummaryResult = {
        ...summary,
        content,
        status: 'completed',
        inputTokens: hasActualStats ? summary.inputTokens : estimatedTokens,
        outputTokens: hasActualStats ? summary.outputTokens : estimatedTokens,
        totalTokens: hasActualStats ? summary.totalTokens : estimatedTokens * 2,
        costUsd: hasActualStats ? summary.costUsd : estimatedCost,
        statsEstimated: !hasActualStats,
      };
      
      setMatter(prev => {
        if (!prev) return prev;
        const updated = {
          ...prev,
          summaries: { ...prev.summaries, [modelId]: updatedSummary },
          updatedAt: new Date().toISOString(),
        };
        saveMatter(updated);
        return updated;
      });
      
      addLogEntry('success', `✅ ${modelName} downloaded: ${content.length.toLocaleString()} chars in ${Math.round(elapsed/1000)}s`);
      toast({
        title: 'Download complete!',
        description: `${modelName}: ${content.length.toLocaleString()} characters extracted`,
      });
      
      // AUTO-START ANALYSIS for this summary if not already analyzed
      if (!matter.qualityScores[modelId]) {
        addLogEntry('info', `🔍 Auto-starting analysis for ${modelName}...`);
        setTimeout(() => {
          analyzeSingleSummary(modelId);
        }, 500);
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      addLogEntry('error', `${modelName} download failed: ${errorMsg}`);
      toast({
        title: 'Download failed',
        description: errorMsg,
        variant: 'destructive',
      });
    } finally {
      setRetryingModels(prev => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  };

  // Run quality analysis on completed summaries (both API-generated and uploaded PDFs)
  const runQualityAnalysis = async () => {
    if (!matter) return;

    setRunningAnalysis(true);
    addLogEntry('info', 'Starting quality analysis with GPT-5.2');
    
    // Set up steps for UI feedback
    setSteps([
      { id: 'extract', label: 'Extract Source Text', status: 'pending', progress: 0 },
      { id: 'analyze', label: 'Quality Analysis', status: 'pending', progress: 0 },
    ]);

    // Get or extract source document content for fact-checking
    // CRITICAL: This extracted text is the source of truth for quality scoring
    let documentContent = matter.sourceDocuments[0]?.content || '';
    
    // If no content yet, we need to extract it from the vault using Gemini Vision
    if (!documentContent && matter.vaultId && matter.sourceDocuments[0]?.objectId) {
      addLogEntry('info', '📄 Extracting source text with Gemini Vision (this is the source of truth for quality analysis)');
      setSteps(prev => prev.map(s => s.id === 'extract' ? { ...s, status: 'running', detail: 'Initializing Gemini Vision...' } : s));
      
      // Use Gemini Vision for more accurate extraction of legal documents
      const { extractVaultObjectWithGemini } = await import('@/lib/case-api');
      
      const extractResult = await extractVaultObjectWithGemini(
        matter.vaultId,
        matter.sourceDocuments[0].objectId,
        (status) => {
          setSteps(prev => prev.map(s => s.id === 'extract' ? { ...s, detail: status } : s));
          addLogEntry('info', `Gemini: ${status}`);
        }
      );
      
      if (extractResult.error || !extractResult.data) {
        const errorMsg = `Failed to extract source text: ${extractResult.error}`;
        addLogEntry('error', errorMsg);
        toast({ title: 'Extraction Failed', description: errorMsg, variant: 'destructive' });
        setRunningAnalysis(false);
        return;
      }
      
      documentContent = extractResult.data.content;
      
      // Save extracted content to matter for future use
      const updatedDoc = {
        ...matter.sourceDocuments[0],
        content: documentContent,
        pageCount: extractResult.data.pageCount,
        tokenEstimate: extractResult.data.tokenEstimate,
      };
      saveMatter({
        ...matter,
        sourceDocuments: [updatedDoc],
        updatedAt: new Date().toISOString(),
      });
      setMatter(prev => prev ? {
        ...prev,
        sourceDocuments: [updatedDoc],
        updatedAt: new Date().toISOString(),
      } : prev);
      
      addLogEntry('success', `✅ Gemini Vision extracted source: ${documentContent.length.toLocaleString()} chars, ${extractResult.data.pageCount || '?'} pages`);
      setSteps(prev => prev.map(s => s.id === 'extract' ? { ...s, status: 'completed', detail: `${documentContent.length.toLocaleString()} chars via Gemini Vision` } : s));
    } else if (documentContent) {
      setSteps(prev => prev.map(s => s.id === 'extract' ? { ...s, status: 'completed', detail: 'Using cached content' } : s));
      addLogEntry('info', `Using cached source content: ${documentContent.length.toLocaleString()} chars`);
    } else {
      // No content and no way to extract - use placeholder
      addLogEntry('warning', '⚠️ No source content available - using placeholder');
      documentContent = `
Source document for ${matter.name}.
Summary Type: ${matter.summaryType}
(Original transcript/records content for verification)
      `.trim();
      setSteps(prev => prev.map(s => s.id === 'extract' ? { ...s, status: 'completed', detail: 'Using placeholder' } : s));
    }

    // Determine what summaries we need to analyze (API-generated summaries)
    // Include both 'completed' and 'completed_no_download' - we'll extract content as needed
    type SummaryToAnalyze = { modelId: string; modelName: string; content: string; needsExtraction: boolean; workflowId?: string };
    
    const readySummaries = Object.values(matter.summaries).filter(
      (s) => (s.status === 'completed' || s.status === 'completed_no_download') && 
             !matter.qualityScores[s.model] // Not yet analyzed
    );
    
    // Build list - some may need content extraction first
    const summariesToAnalyze: SummaryToAnalyze[] = readySummaries.map(s => {
      const model = TEST_MODELS.find(m => m.id === s.model);
      const hasRealContent = s.content && s.content.length > 100 && s.content !== '[CONTENT_NOT_EXTRACTED]';
      return {
        modelId: s.model,
        modelName: model?.name || s.model,
        content: hasRealContent ? s.content : '',
        needsExtraction: !hasRealContent && !!s.casemarkWorkflowId,
        workflowId: s.casemarkWorkflowId,
      };
    });
    
    console.log(`[Quality Analysis] ${summariesToAnalyze.length} summaries to analyze (${summariesToAnalyze.filter(s => s.needsExtraction).length} need extraction)`);

    if (summariesToAnalyze.length === 0) {
      toast({ title: 'No summaries to analyze', description: 'All summaries have already been analyzed or are not ready.' });
      setRunningAnalysis(false);
      return;
    }

    const qualityScores: Record<string, QualityScore> = { ...matter.qualityScores };
    
    // Start analysis phase
    setSteps(prev => prev.map(s => s.id === 'analyze' ? { ...s, status: 'running', progress: 0 } : s));
    setAnalysisProgress({ current: 0, total: summariesToAnalyze.length, currentModel: '' });

    for (let i = 0; i < summariesToAnalyze.length; i++) {
      let summary = summariesToAnalyze[i];
      const progress = ((i + 1) / summariesToAnalyze.length) * 100;
      
      // Track which model is being analyzed - UPDATE BOTH states for UI
      setAnalyzingModels(prev => new Set([...prev, summary.modelId]));
      setAnalysisModelId(summary.modelId); // This drives the "Analyzing..." UI in Quality Analysis section
      setCurrentModelStartTime(Date.now()); // Reset timer for this model
      setAnalysisProgress({ current: i + 1, total: summariesToAnalyze.length, currentModel: summary.modelName });
      
      // Update activity banner to show which model is being analyzed
      addLogEntry('info', `🔍 Analyzing ${summary.modelName}...`);
      
      setSteps(prev => prev.map(s => s.id === 'analyze' ? {
        ...s,
        status: 'running',
        progress,
        detail: `Analyzing ${summary.modelName} (${i + 1}/${summariesToAnalyze.length})`,
      } : s));

      // Extract content if needed
      if (summary.needsExtraction && summary.workflowId) {
        addLogEntry('info', `📥 Extracting ${summary.modelName} content...`);
        setExtractingModels(prev => new Set([...prev, summary.modelId]));
        
        try {
          const downloadResult = await downloadCaseMarkResult(summary.workflowId, 'PDF');
          if (downloadResult.data && downloadResult.data.length > 100) {
            summary = { ...summary, content: downloadResult.data, needsExtraction: false };
            
            // Update the matter with extracted content
            const existingSummary = matter.summaries[summary.modelId];
            if (existingSummary) {
              // Use actual stats from API if available, otherwise estimate
              const hasActualStats = !!(existingSummary.inputTokens && existingSummary.inputTokens > 0 && existingSummary.costUsd && existingSummary.costUsd > 0);
              const estimatedTokens = Math.ceil(downloadResult.data.length / 4);
              const model = TEST_MODELS.find(m => m.id === summary.modelId);
              const estimatedCost = model ? calculateCost(estimatedTokens, estimatedTokens, model.inputPricePer1M, model.outputPricePer1M) : 0;
              
              const updatedSummary = {
                ...existingSummary,
                content: downloadResult.data,
                status: 'completed' as const,
                inputTokens: hasActualStats ? existingSummary.inputTokens : estimatedTokens,
                outputTokens: hasActualStats ? existingSummary.outputTokens : estimatedTokens,
                totalTokens: hasActualStats ? existingSummary.totalTokens : estimatedTokens * 2,
                costUsd: hasActualStats ? existingSummary.costUsd : estimatedCost,
                statsEstimated: !hasActualStats,
              };
              
              setMatter(prev => prev ? {
                ...prev,
                summaries: { ...prev.summaries, [summary.modelId]: updatedSummary },
              } : prev);
              saveMatter({
                ...matter,
                summaries: { ...matter.summaries, [summary.modelId]: updatedSummary },
              });
            }
            
            const statsLabel = existingSummary?.statsEstimated ? ' (stats estimated)' : '';
            addLogEntry('success', `   └─ ${summary.modelName}: ${downloadResult.data.length.toLocaleString()} chars extracted${statsLabel}`);
          } else {
            addLogEntry('error', `   └─ ${summary.modelName}: Extraction failed or empty content`);
            setExtractingModels(prev => { const next = new Set(prev); next.delete(summary.modelId); return next; });
            setAnalyzingModels(prev => { const next = new Set(prev); next.delete(summary.modelId); return next; });
            continue; // Skip this summary
          }
        } catch (error) {
          addLogEntry('error', `   └─ ${summary.modelName}: ${error instanceof Error ? error.message : 'Extraction error'}`);
          setExtractingModels(prev => { const next = new Set(prev); next.delete(summary.modelId); return next; });
          setAnalyzingModels(prev => { const next = new Set(prev); next.delete(summary.modelId); return next; });
          continue; // Skip this summary
        }
        
        setExtractingModels(prev => { const next = new Set(prev); next.delete(summary.modelId); return next; });
      }

      // Check if we have a control summary to compare against
      const hasControl = !!matter.controlSummary?.content;
      const summaryTypeName = SUMMARY_TYPE_INFO[matter.summaryType]?.label || matter.summaryType;
      
      // Use different prompts based on whether control exists
      const basePrompt = hasControl ? QUALITY_ANALYSIS_PROMPT : QUALITY_ANALYSIS_PROMPT_NO_CONTROL;
      const analysisPrompt = basePrompt.replace('{summary_type_name}', summaryTypeName);

      // Build the user prompt - comparing TEST vs CONTROL
      let userContent: string;
      
      if (hasControl) {
        // SOURCE is the gold standard for accuracy, CONTROL is just for reference comparison
        userContent = `=== ORIGINAL SOURCE DOCUMENT (THIS IS THE GOLD STANDARD - verify all facts against this) ===
${documentContent}

=== TEST SUMMARY TO EVALUATE (Score this based on accuracy to SOURCE above) ===
Model: ${summary.modelName}
${summary.content}

=== CONTROL SUMMARY (Current production output - FOR REFERENCE ONLY, may have its own errors) ===
${matter.controlSummary!.content}`;
      } else {
        // No control - compare against source document only
        userContent = `ORIGINAL DOCUMENT:\n${documentContent}\n\nSUMMARY TO EVALUATE:\n${summary.content}`;
      }

      try {
        console.log(`[Quality Analysis] Starting analysis for ${summary.modelId}${hasControl ? ' (with control comparison)' : ''}`);
        addLogEntry('info', `🤖 QUALITY ANALYSIS: ${summary.modelName} (${i + 1}/${summariesToAnalyze.length})`);
        addLogEntry('info', `   └─ Sending to GPT-5.2 Judge for evaluation...`);
        
        const result = await createChatCompletion(JUDGE_MODEL.id, [
          { role: 'system', content: analysisPrompt },
          {
            role: 'user',
            content: userContent,
          },
        ]);

        console.log(`[Quality Analysis] Got response for ${summary.modelId}:`, {
          hasData: !!result.data,
          hasChoices: !!result.data?.choices?.[0],
          contentLength: result.data?.choices?.[0]?.message?.content?.length,
        });

        if (result.data && result.data.choices[0]) {
          const content = result.data.choices[0].message.content;
          
          // Try to extract JSON - handle both raw JSON and markdown-wrapped JSON
          let jsonString = content;
          const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (codeBlockMatch) {
            jsonString = codeBlockMatch[1];
          } else {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              jsonString = jsonMatch[0];
            }
          }
          
          console.log(`[Quality Analysis] Extracted JSON for ${summary.modelId}, length:`, jsonString.length);
          
          try {
            const parsed = JSON.parse(jsonString);
            console.log(`[Quality Analysis] Parsed JSON for ${summary.modelId}:`, {
              overallScore: parsed.overall_score,
              hasFactualAccuracy: !!parsed.factual_accuracy,
            });
            
            const analysisCost = calculateCost(
              result.data.usage?.prompt_tokens || 0,
              result.data.usage?.completion_tokens || 0,
              JUDGE_MODEL.inputPricePer1M,
              JUDGE_MODEL.outputPricePer1M
            );

            // Normalize score from 0-10 to 0-100 if LLM returned old scale
            const normalizeScore = (score: number): number => {
              if (score <= 10) return score * 10; // Convert 0-10 to 0-100
              return Math.min(score, 100); // Cap at 100
            };

            const parseCategoryScore = (value: unknown, fallback = 0) => {
              if (typeof value === 'number') {
                return { score: normalizeScore(value), rationale: '', examples: [] };
              }
              if (typeof value === 'object' && value !== null) {
                const obj = value as Record<string, unknown>;
                const rawScore = typeof obj.score === 'number' ? obj.score : fallback;
                return {
                  score: normalizeScore(rawScore),
                  rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
                  examples: Array.isArray(obj.examples) ? obj.examples : [],
                };
              }
              return { score: normalizeScore(fallback), rationale: '', examples: [] };
            };

            const specificErrors = Array.isArray(parsed.specific_errors)
              ? parsed.specific_errors.map((e: Record<string, unknown>) => ({
                  type: e.type || 'factual',
                  severity: e.severity || 'minor',
                  summaryExcerpt: e.summary_excerpt || '',
                  sourceReference: e.source_reference || '',
                  explanation: e.explanation || '',
                  correction: e.correction || '',
                }))
              : [];

            const rawOverallScore = parsed.overall_score || 0;
            const overallScore = normalizeScore(rawOverallScore);
            console.log(`[Quality Analysis] Score normalization: ${rawOverallScore} → ${overallScore}`);

            qualityScores[summary.modelId] = {
              model: summary.modelId,
              factualAccuracy: parseCategoryScore(parsed.factual_accuracy),
              pageLineAccuracy: parseCategoryScore(parsed.page_line_accuracy),
              relevance: parseCategoryScore(parsed.relevance),
              comprehensiveness: parseCategoryScore(parsed.comprehensiveness),
              legalUtility: parseCategoryScore(parsed.legal_utility),
              overallScore,
              strengths: parsed.strengths || [],
              weaknesses: parsed.weaknesses || [],
              specificErrors,
              missingItems: parsed.missing_items || [],
              // Control comparison (can be string or object)
              controlComparison: typeof parsed.control_comparison === 'object' && parsed.control_comparison !== null
                ? {
                    summary: parsed.control_comparison.summary || '',
                    testBetterThanControl: parsed.control_comparison.test_better_than_control || [],
                    testWorseThanControl: parsed.control_comparison.test_worse_than_control || [],
                    testIncludesControlMissing: parsed.control_comparison.test_includes_control_missing || [],
                    controlIncludesTestMissing: parsed.control_comparison.control_includes_test_missing || [],
                  }
                : (parsed.control_comparison || ''),
              missingFromTest: parsed.missing_from_test || [],
              extraInTest: parsed.extra_in_test || [],
              analysisNotes: parsed.analysis_notes || '',
              recommendation: parsed.recommendation || '',
              costUsd: analysisCost,
              costEffectiveness: 0, // Cost effectiveness not applicable for uploaded PDFs
            };
            
            console.log(`[Quality Analysis] Successfully created score for ${summary.modelId}:`, overallScore, hasControl ? '(vs control)' : '');
            addLogEntry('success', `   └─ ✅ ${summary.modelName}: Score ${overallScore}/100 (analysis cost: $${analysisCost.toFixed(4)})`);
          } catch (parseError) {
            console.error(`[Quality Analysis] JSON parse error for ${summary.modelId}:`, parseError);
            console.error(`[Quality Analysis] Raw content:`, content.substring(0, 500));
            addLogEntry('error', `Failed to parse analysis for ${summary.modelName}`);
          }
        } else {
          console.error(`[Quality Analysis] No valid response data for ${summary.modelId}`);
          addLogEntry('warning', `No response data for ${summary.modelName}`);
        }
      } catch (error) {
        console.error('[Quality Analysis] API error for', summary.modelId, error);
        addLogEntry('error', `API error analyzing ${summary.modelName}`);
      } finally {
        // Remove model from analyzing set
        setAnalyzingModels(prev => {
          const next = new Set(prev);
          next.delete(summary.modelId);
          return next;
        });
      }
    }

    // Update with all accumulated quality scores at once
    console.log(`[Quality Analysis] Final scores count: ${Object.keys(qualityScores).length}`);
    console.log(`[Quality Analysis] Score models:`, Object.keys(qualityScores));

    // Mark analysis complete
    setSteps([{
      id: 'analyze',
      label: 'Quality Analysis',
      status: 'completed',
      progress: 100,
    }]);
    
    // Update matter with all quality scores and completed status
    const finalUpdate = { 
      qualityScores, 
      status: 'completed' as const 
    };
    console.log(`[Quality Analysis] Saving final update:`, {
      scoreCount: Object.keys(qualityScores).length,
      status: 'completed'
    });
    updateMatter(finalUpdate);
    
    // Clear analysis tracking state
    setRunningAnalysis(false);
    setAnalyzingModels(new Set());
    setExtractingModels(new Set());
    setAnalysisProgress(null);
    setAnalysisModelId(null); // Clear the current model being analyzed
    setCurrentModelStartTime(null); // Clear timer
    
    // Notify user
    const scoreCount = Object.keys(qualityScores).length;
    addLogEntry('success', `✅ Quality analysis complete: ${scoreCount} summaries scored`);
    
    // Clear activity banner AFTER the log entry (since addLogEntry sets it)
    setCurrentActivity('');
    
    if (scoreCount > 0) {
      toast({
        title: "Analysis Complete",
        description: `Successfully analyzed ${scoreCount} summaries. View results below.`,
      });
    } else {
      toast({
        title: "Analysis Issue",
        description: "Analysis completed but no scores were generated. Check console for errors.",
        variant: "destructive",
      });
    }
  };

  // Auto-start quality analysis when all summaries are complete
  useEffect(() => {
    if (!matter) return;
    if (processing || runningAnalysis) return; // Don't interrupt active processing
    if (matter.status === 'completed') return; // Already done
    if (matter.status === 'analyzing') return; // Already analyzing
    
    const selectedModels = matter.modelsToTest?.length 
      ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
      : TEST_MODELS;
    
    // Count completed summaries (with actual content, not placeholders)
    const completedSummaries = selectedModels.filter(m => {
      const summary = matter.summaries[m.id];
      return summary?.status === 'completed' && 
             summary?.content && 
             summary.content !== '[CONTENT_NOT_EXTRACTED]' &&
             summary.content.length > 100;
    });
    
    // Check if all selected models have completed summaries
    const allComplete = completedSummaries.length === selectedModels.length;
    
    // Check if quality analysis is needed
    const hasQualityScores = Object.keys(matter.qualityScores).length > 0;
    const needsAnalysis = allComplete && !hasQualityScores;
    
    if (needsAnalysis) {
      console.log('[Auto-Analysis] All summaries complete, starting quality analysis...', {
        selectedModels: selectedModels.map(m => m.name),
        completedSummaries: completedSummaries.map(m => m.name),
        qualityScoresCount: Object.keys(matter.qualityScores).length,
      });
      addLogEntry('info', '═══════════════════════════════════════');
      addLogEntry('info', '🔍 Auto-starting Quality Analysis');
      addLogEntry('info', `All ${selectedModels.length} summaries ready`);
      addLogEntry('info', '═══════════════════════════════════════');
      
      // Trigger quality analysis
      runQualityAnalysis();
    }
  }, [matter?.summaries, matter?.qualityScores, matter?.status, processing, runningAnalysis]);

  // NOTE: Auto-extraction disabled for performance
  // Text extraction happens just before quality analysis (which is faster overall)
  // The completed_no_download status shows "CaseMark Done" immediately
  // useEffect for auto-extract removed - extraction happens in runQualityAnalysis

  // Analyze a single summary that's ready but not yet analyzed
  const analyzeSingleSummary = async (modelId: string) => {
    if (!matter) return;
    
    const summary = matter.summaries[modelId];
    if (!summary || summary.status !== 'completed' || !summary.content) {
      toast({ title: 'Cannot analyze', description: 'Summary is not ready for analysis.' });
      return;
    }
    
    if (matter.qualityScores[modelId]) {
      toast({ title: 'Already analyzed', description: 'This summary has already been analyzed.' });
      return;
    }

    setAnalyzingModelId(modelId);
    
    const model = TEST_MODELS.find(m => m.id === modelId);
    const modelName = model?.name || modelId;
    
    const documentContent = matter.sourceDocuments[0]?.content || `
Source document for ${matter.name}.
Summary Type: ${matter.summaryType}
(Original transcript/records content for verification)
    `.trim();

    const hasControl = !!matter.controlSummary?.content;
    const summaryTypeName = SUMMARY_TYPE_INFO[matter.summaryType]?.label || matter.summaryType;
    const basePrompt = hasControl ? QUALITY_ANALYSIS_PROMPT : QUALITY_ANALYSIS_PROMPT_NO_CONTROL;
    const analysisPrompt = basePrompt.replace('{summary_type_name}', summaryTypeName);

    let userContent: string;
    if (hasControl) {
      // SOURCE is the gold standard for accuracy, CONTROL is just for reference comparison
      userContent = `=== ORIGINAL SOURCE DOCUMENT (THIS IS THE GOLD STANDARD - verify all facts against this) ===
${documentContent}

=== TEST SUMMARY TO EVALUATE (Score this based on accuracy to SOURCE above) ===
Model: ${modelName}
${summary.content}

=== CONTROL SUMMARY (Current production output - FOR REFERENCE ONLY, may have its own errors) ===
${matter.controlSummary!.content}`;
    } else {
      userContent = `ORIGINAL DOCUMENT:\n${documentContent}\n\nSUMMARY TO EVALUATE:\n${summary.content}`;
    }

    try {
      debugLogger.info(`🔍 Analyzing single summary: ${modelName}`, { modelId, hasControl }, 'processing');
      
      const result = await createChatCompletion(JUDGE_MODEL.id, [
        { role: 'system', content: analysisPrompt },
        { role: 'user', content: userContent },
      ]);

      if (result.data && result.data.choices[0]) {
        const content = result.data.choices[0].message.content;
        
        let jsonString = content;
        const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          jsonString = codeBlockMatch[1];
        } else {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            jsonString = jsonMatch[0];
          }
        }
        
        const parsed = JSON.parse(jsonString);
        const analysisCost = calculateCost(
          result.data.usage?.prompt_tokens || 0,
          result.data.usage?.completion_tokens || 0,
          JUDGE_MODEL.inputPricePer1M,
          JUDGE_MODEL.outputPricePer1M
        );

        // Normalize score from 0-10 to 0-100 if LLM returned old scale
        const normalizeScore = (score: number): number => {
          if (score <= 10) return score * 10; // Convert 0-10 to 0-100
          return Math.min(score, 100); // Cap at 100
        };

        const parseCategoryScore = (value: unknown, fallback = 0) => {
          if (typeof value === 'number') {
            return { score: normalizeScore(value), rationale: '', examples: [] };
          }
          if (typeof value === 'object' && value !== null) {
            const obj = value as Record<string, unknown>;
            const rawScore = typeof obj.score === 'number' ? obj.score : fallback;
            return {
              score: normalizeScore(rawScore),
              rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
              examples: Array.isArray(obj.examples) ? obj.examples : [],
            };
          }
          return { score: normalizeScore(fallback), rationale: '', examples: [] };
        };

        const specificErrors = Array.isArray(parsed.specific_errors)
          ? parsed.specific_errors.map((e: Record<string, unknown>) => ({
              type: e.type || 'factual',
              severity: e.severity || 'minor',
              summaryExcerpt: e.summary_excerpt || '',
              sourceReference: e.source_reference || '',
              explanation: e.explanation || '',
              correction: e.correction || '',
            }))
          : [];

        const rawOverallScore = parsed.overall_score || 0;
        const overallScore = normalizeScore(rawOverallScore);
        const summaryForCostEff = matter.summaries[modelId];

        const newScore: QualityScore = {
          model: modelId,
          factualAccuracy: parseCategoryScore(parsed.factual_accuracy),
          pageLineAccuracy: parseCategoryScore(parsed.page_line_accuracy),
          relevance: parseCategoryScore(parsed.relevance),
          comprehensiveness: parseCategoryScore(parsed.comprehensiveness),
          legalUtility: parseCategoryScore(parsed.legal_utility),
          overallScore,
          strengths: parsed.strengths || [],
          weaknesses: parsed.weaknesses || [],
          specificErrors,
          missingItems: parsed.missing_items || [],
          // Control comparison (can be string or object)
          controlComparison: typeof parsed.control_comparison === 'object' && parsed.control_comparison !== null
            ? {
                summary: parsed.control_comparison.summary || '',
                testBetterThanControl: parsed.control_comparison.test_better_than_control || [],
                testWorseThanControl: parsed.control_comparison.test_worse_than_control || [],
                testIncludesControlMissing: parsed.control_comparison.test_includes_control_missing || [],
                controlIncludesTestMissing: parsed.control_comparison.control_includes_test_missing || [],
              }
            : (parsed.control_comparison || ''),
          missingFromTest: parsed.missing_from_test || [],
          extraInTest: parsed.extra_in_test || [],
          analysisNotes: parsed.analysis_notes || '',
          recommendation: parsed.recommendation || '',
          costUsd: analysisCost,
          costEffectiveness: summaryForCostEff?.costUsd ? overallScore / summaryForCostEff.costUsd : 0,
        };

        updateMatter({ 
          qualityScores: { ...matter.qualityScores, [modelId]: newScore } 
        });
        
        debugLogger.info(`✅ Single analysis complete: ${modelName} scored ${overallScore}`, {}, 'processing');
        
        toast({
          title: `Analysis Complete`,
          description: `${modelName} scored ${Math.round(overallScore)}/100`,
        });
      } else {
        throw new Error(result.error || 'No response data');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Analysis failed';
      debugLogger.error(`❌ Single analysis failed: ${modelName}`, { error: errorMsg }, 'processing');
      toast({
        title: 'Analysis Failed',
        description: `Failed to analyze ${modelName}: ${errorMsg}`,
        variant: 'destructive',
      });
    } finally {
      setAnalyzingModelId(null);
    }
  };

  // Helper to convert data URL to File
  const dataUrlToFile = (dataUrl: string, filename: string): File => {
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'application/pdf';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  };

  const startProcessing = async () => {
    if (!matter) return;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETAILED STATE LOGGING AT START OF PROCESSING
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('[startProcessing] ═══════════════════════════════════════════');
    console.log('[startProcessing] STARTING PROCESSING');
    console.log('[startProcessing] Matter Status:', matter.status);
    console.log('[startProcessing] Existing Summaries:', Object.entries(matter.summaries || {}).map(([modelId, s]) => ({
      model: modelId,
      status: s.status,
      hasContent: !!s.content && s.content.length > 100,
      contentLength: s.content?.length || 0,
    })));
    console.log('[startProcessing] Models to Test:', matter.modelsToTest);
    console.log('[startProcessing] ═══════════════════════════════════════════');

    // Add separator if there's existing log, don't clear
    setShowProcessingLog(true); // Auto-show the log when starting
    setCurrentActivity('Initializing...');

    debugLogger.info('🚀 Starting processing', { matterId: matter.id, matterName: matter.name }, 'processing');
    setProcessing(true);
    
    // Add initial log entries (keep previous entries)
    addLogEntry('info', `════════════════════════════════════════`);
    addLogEntry('info', `🚀 Starting processing pipeline`, `Matter: ${matter.name}`);
    addLogEntry('info', `📋 Summary Type: ${matter.summaryType}`);

    // Get models to test (from wizard selection, or all TEST_MODELS as fallback)
    const modelsToRun = matter.modelsToTest 
      ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
      : TEST_MODELS;

    debugLogger.info(`📋 Models to run: ${modelsToRun.length}`, { 
      models: modelsToRun.map(m => m.name),
      selectedIds: matter.modelsToTest 
    }, 'processing');
    addLogEntry('info', `📊 Selected ${modelsToRun.length} models for comparison`, modelsToRun.map(m => m.name).join(', '));

    // Check if we have control summary
    const hasControl = !!matter.controlSummary;
    if (hasControl) {
      addLogEntry('info', '✓ Control summary available for comparison');
    } else {
      addLogEntry('info', 'ℹ️ No control summary - will evaluate against source only');
    }

    // Initialize steps - now includes document processing
    const initialSteps: ProcessingStep[] = [
      { id: 'process', label: 'Process Documents', status: 'pending' },
      { id: 'summarize', label: `Generate Summaries (${modelsToRun.length} models)`, status: 'pending' },
      { id: 'analyze', label: 'Quality Analysis', status: 'pending' },
    ];
    setSteps(initialSteps);
    addLogEntry('info', '📝 Initialized 3-step pipeline: Process → Summarize → Analyze');

    try {
      // ========== STEP 1: Process Documents ==========
      addLogEntry('info', '═══════════════════════════════════════');
      addLogEntry('info', '📄 STEP 1: Process Documents');
      addLogEntry('info', '═══════════════════════════════════════');
      setCurrentPhase('process');
      setCurrentModelStartTime(Date.now());
      updateStep('process', { status: 'running', progress: 0, detail: 'Preparing documents...' });
      updateMatter({ status: 'processing' });

      let documentContent = matter.sourceDocuments[0]?.content || '';
      let documentUrl: string | null = null;
      let vaultId = matter.vaultId;
      let objectId = matter.sourceDocuments[0]?.objectId;
      let controlContent = matter.controlSummary?.content || '';

      // Initialize document processing status
      const sourceFilename = matter.sourceDocuments[0]?.filename || 'document.pdf';
      const controlFilename = matter.controlSummary?.filename || 'control.pdf';
      const initialDocStatus: DocProcessingStatus[] = [
        {
          filename: sourceFilename,
          type: 'source',
          status: 'pending',
          size: matter.sourceDocuments[0]?.size,
        },
      ];
      if (hasControl) {
        initialDocStatus.push({
          filename: controlFilename,
          type: 'control',
          status: 'pending',
          size: matter.controlSummary?.fileSize,
        });
      }
      setDocProcessingStatus(initialDocStatus);

      // Helper to update doc status
      const updateDocStatus = (type: 'source' | 'control', updates: Partial<DocProcessingStatus>) => {
        setDocProcessingStatus(prev => prev.map(d => 
          d.type === type ? { ...d, ...updates } : d
        ));
      };

      // Helper to check if file is text
      const isTextFile = (filename: string): boolean => {
        return filename.toLowerCase().endsWith('.txt');
      };

      // Helper to read text content from data URL
      const readTextFromDataUrl = (dataUrl: string): string => {
        const base64 = dataUrl.split(',')[1];
        return atob(base64);
      };

      // Check if we need to process the source document
      const needsSourceProcessing = !documentContent || !vaultId || !objectId;
      
      if (needsSourceProcessing) {
        // Try to get file from sessionStorage
        const sourceDataUrl = sessionStorage.getItem(`source_file_${matter.id}`);
        
        if (sourceDataUrl) {
          debugLogger.info('📄 Found source file in sessionStorage, processing...', {}, 'processing');
          addLogEntry('info', `Processing source: ${sourceFilename}`);
          
          // Check if it's a text file (no OCR needed)
          if (isTextFile(sourceFilename)) {
            debugLogger.info('📝 Text file detected, reading directly (no OCR)', {}, 'processing');
            addLogEntry('info', 'Text file detected - skipping OCR');
            
            updateDocStatus('source', { 
              status: 'processing', 
              detail: 'Reading text file...',
              startTime: Date.now()
            });
            updateStep('process', { detail: `Reading ${sourceFilename}...` });
            
            // Read text content directly
            documentContent = readTextFromDataUrl(sourceDataUrl);
            
            // For text files, we still need to upload to vault for CaseMark API
            const sourceFile = dataUrlToFile(sourceDataUrl, sourceFilename);
            const { createVault, uploadToVault } = await import('@/lib/case-api');
            
            updateDocStatus('source', { 
              status: 'uploading', 
              detail: 'Uploading to vault for processing...'
            });
            
            const vaultResult = await createVault(`matter-${matter.id}`, `Vault for ${matter.name}`);
            if (vaultResult.error || !vaultResult.data) {
              throw new Error(`Failed to create vault: ${vaultResult.error}`);
            }
            vaultId = vaultResult.data.id;
            
            const uploadResult = await uploadToVault(vaultId, sourceFile);
            if (uploadResult.error || !uploadResult.data) {
              throw new Error(`Failed to upload: ${uploadResult.error}`);
            }
            objectId = uploadResult.data.objectId;
            
            // Estimate tokens (~4 chars per token)
            const tokenEstimate = Math.ceil(documentContent.length / 4);
            
            // Update status to completed
            updateDocStatus('source', { 
              status: 'completed', 
              detail: 'Ready (text file - no OCR)',
              charCount: documentContent.length
            });
            
            // Update matter with extracted data
            updateMatter({
              vaultId,
              sourceDocuments: [{
                ...matter.sourceDocuments[0],
                content: documentContent,
                objectId,
                tokenEstimate,
              }],
            });
            
            debugLogger.info('✅ Text file processed', { 
              contentLength: documentContent.length,
              vaultId,
              objectId
            }, 'processing');
            addLogEntry('success', `Source document ready: ${documentContent.length.toLocaleString()} characters`);
          } else {
            // PDF file - upload WITHOUT extraction
            // CaseMark will process the PDF directly
            // Text extraction happens separately before quality analysis
            updateDocStatus('source', { 
              status: 'uploading', 
              detail: 'Uploading PDF (no extraction yet)...',
              startTime: Date.now()
            });
            updateStep('process', { detail: `Uploading ${sourceFilename}...` });
            addLogEntry('info', 'Uploading PDF to vault (CaseMark will process directly)');
            
            const sourceFile = dataUrlToFile(sourceDataUrl, sourceFilename);
            
            // Import and use uploadPdfToVault (NO extraction)
            const { uploadPdfToVault } = await import('@/lib/case-api');
            
            const uploadResult = await uploadPdfToVault(sourceFile, (status) => {
              updateDocStatus('source', { 
                status: 'uploading', 
                detail: status 
              });
              updateStep('process', { detail: `${sourceFilename}: ${status}` });
            });
            
            if (uploadResult.error || !uploadResult.data) {
              updateDocStatus('source', { status: 'error', detail: uploadResult.error || 'Upload failed' });
              throw new Error(`Failed to upload source document: ${uploadResult.error}`);
            }
            
            vaultId = uploadResult.data.vaultId;
            objectId = uploadResult.data.objectId;
            // Note: content is NOT extracted yet - that happens before quality analysis
            documentContent = ''; // Will be extracted later for quality analysis
            
            // Update status to completed (upload done)
            updateDocStatus('source', { 
              status: 'completed', 
              detail: 'Uploaded (ready for CaseMark)',
            });
            
            // Update matter with vault info (no content yet)
            updateMatter({
              vaultId,
              sourceDocuments: [{
                ...matter.sourceDocuments[0],
                objectId,
                // content will be populated before quality analysis
              }],
            });
            
            debugLogger.info('✅ PDF uploaded (no extraction yet)', { 
              vaultId,
              objectId,
              filename: sourceFilename
            }, 'processing');
            addLogEntry('success', `Source PDF uploaded - ready for CaseMark summary`);
            addLogEntry('info', 'Text extraction will happen before quality analysis');
          }
          
          // Clean up sessionStorage
          sessionStorage.removeItem(`source_file_${matter.id}`);
        } else {
          debugLogger.warn('⚠️ No source file found and no content stored', {}, 'processing');
          updateDocStatus('source', { status: 'error', detail: 'File not found in session' });
          addLogEntry('error', 'Source file not found in session');
        }
      } else {
        // Already processed
        updateDocStatus('source', { 
          status: 'completed', 
          detail: 'Already processed',
          charCount: documentContent.length,
          pageCount: matter.sourceDocuments[0]?.pageCount
        });
        debugLogger.info('📄 Using existing source document content', { 
          contentLength: documentContent.length 
        }, 'processing');
        addLogEntry('info', 'Source document already processed - using cached content');
      }

      // Process control document if needed
      if (hasControl && !controlContent) {
        const controlDataUrl = sessionStorage.getItem(`control_file_${matter.id}`);
        
        if (controlDataUrl) {
          debugLogger.info('📄 Found control file in sessionStorage, processing...', {}, 'processing');
          updateStep('process', { progress: 50, detail: `Processing ${controlFilename}...` });
          
          // Check if it's a text file
          if (isTextFile(controlFilename)) {
            debugLogger.info('📝 Control is text file, reading directly', {}, 'processing');
            
            updateDocStatus('control', { 
              status: 'processing', 
              detail: 'Reading text file...',
              startTime: Date.now()
            });
            
            // Read text content directly
            controlContent = readTextFromDataUrl(controlDataUrl);
            
            // Update control status to completed
            updateDocStatus('control', { 
              status: 'completed', 
              detail: 'Ready (text file - no OCR)',
              charCount: controlContent.length
            });
            
            // Update matter with control content
            updateMatter({
              controlSummary: {
                ...matter.controlSummary!,
                content: controlContent,
                tokenCount: Math.ceil(controlContent.length / 4),
              },
            });
            
            debugLogger.info('✅ Control text file processed', { 
              contentLength: controlContent.length 
            }, 'processing');
          } else {
            // PDF file - needs OCR
            updateDocStatus('control', { 
              status: 'uploading', 
              detail: 'Uploading to secure vault...',
              startTime: Date.now()
            });
            
            const controlFile = dataUrlToFile(controlDataUrl, controlFilename);
            
            const { extractPdfViaVault } = await import('@/lib/case-api');
            
            const controlResult = await extractPdfViaVault(controlFile, (status) => {
              // Parse status for control doc
              let docStatus: DocProcessingStatus['status'] = 'processing';
              let detail = status;
              
              if (status.includes('Creating vault') || status.includes('Uploading')) {
                docStatus = 'uploading';
              } else if (status.includes('text extraction') || status.includes('OCR') || status.includes('Processing')) {
                docStatus = 'extracting';
                detail = status.includes('OCR') ? 'Running OCR...' : status;
              }
              
              updateDocStatus('control', { status: docStatus, detail });
              updateStep('process', { detail: `${controlFilename}: ${detail}` });
            });
            
            if (controlResult.error || !controlResult.data) {
              updateDocStatus('control', { status: 'error', detail: controlResult.error || 'Extraction failed' });
              debugLogger.warn('⚠️ Failed to process control document', { error: controlResult.error }, 'processing');
              toast({
                title: 'Control processing failed',
                description: 'Continuing without control comparison',
                variant: 'destructive',
              });
            } else {
              controlContent = controlResult.data.content;
              
              // Update control status to completed
              updateDocStatus('control', { 
                status: 'completed', 
                detail: 'Ready',
                pageCount: controlResult.data.pageCount,
                charCount: controlContent.length
              });
              
              // Update matter with control content
              updateMatter({
                controlSummary: {
                  ...matter.controlSummary!,
                  content: controlContent,
                  pageCount: controlResult.data.pageCount,
                  tokenCount: controlResult.data.tokenEstimate,
                },
              });
              
              debugLogger.info('✅ Control document processed', { 
                contentLength: controlContent.length 
              }, 'processing');
            }
          }
          
          // Clean up sessionStorage
          sessionStorage.removeItem(`control_file_${matter.id}`);
        }
      } else if (hasControl && controlContent) {
        // Control already processed
        updateDocStatus('control', { 
          status: 'completed', 
          detail: 'Already processed',
          charCount: controlContent.length,
          pageCount: matter.controlSummary?.pageCount
        });
      }

      updateStep('process', { status: 'completed', progress: 100, detail: undefined });
      addLogEntry('success', 'Document processing complete');
      
      // Document processing complete - show toast
      const sourceDoc = docProcessingStatus.find(d => d.type === 'source');
      const controlDoc = docProcessingStatus.find(d => d.type === 'control');
      toast({
        title: 'Documents processed',
        description: `Source: ${sourceDoc?.charCount?.toLocaleString() || '?'} chars${controlDoc ? ` • Control: ${controlDoc?.charCount?.toLocaleString() || '?'} chars` : ''}`,
      });
      
      // Reset timer for next phase
      setCurrentModelStartTime(null);

      // Get presigned URL for CaseMark API
      if (vaultId && objectId) {
        debugLogger.info('🔗 Getting presigned URL for CaseMark...', { vaultId, objectId }, 'processing');
        addLogEntry('info', 'Getting presigned URL for CaseMark API');
        const urlResult = await getVaultPresignedUrl(vaultId, objectId);
        if (urlResult.data?.url) {
          documentUrl = urlResult.data.url;
          debugLogger.info('✅ Got presigned URL', { urlPrefix: documentUrl.substring(0, 80) }, 'processing');
          addLogEntry('success', 'Got presigned document URL for CaseMark');
        } else {
          debugLogger.error('❌ Failed to get presigned URL', { error: urlResult.error }, 'processing');
          addLogEntry('error', `Failed to get presigned URL: ${urlResult.error || 'unknown'}`);
        }
      } else {
        debugLogger.warn('⚠️ No vaultId or objectId - cannot get presigned URL', { vaultId, objectId }, 'processing');
        addLogEntry('warning', 'No vault/object ID - will use raw LLM fallback');
      }

      // summaryType IS the CaseMark workflow type now (e.g., 'DEPOSITION_ANALYSIS')
      const workflowType: CaseMarkWorkflowType = matter.summaryType;

      // ========== STEP 2: Generate Summaries ==========
      // CRITICAL: We MUST have a document URL for CaseMark API - no fallbacks
      if (!documentUrl) {
        const errorMsg = 'Failed to get document URL for CaseMark API. Cannot generate summaries without it.';
        debugLogger.error(`❌ ${errorMsg}`, { vaultId, objectId }, 'processing');
        addLogEntry('error', errorMsg);
        toast({
          title: 'CaseMark API Error',
          description: 'Could not get document URL. Please check your source document and try again.',
          variant: 'destructive',
        });
        throw new Error(errorMsg);
      }

      addLogEntry('info', '═══════════════════════════════════════');
      addLogEntry('info', '🤖 STEP 2: Generate Summaries');
      addLogEntry('info', '═══════════════════════════════════════');
      setCurrentPhase('summarize');
      updateStep('summarize', { status: 'running', progress: 0 });
      updateMatter({ status: 'summarizing' });
      addLogEntry('info', `📡 CaseMark API: ${workflowType}`);
      addLogEntry('info', `🎯 Models to process: ${modelsToRun.length}`, modelsToRun.map(m => m.name).join(', '));

      const summaries: Record<string, SummaryResult> = { ...matter.summaries };
      const totalModels = modelsToRun.length;

      // Reset cancellation state at start
      cancelRequestedRef.current = false;
      activeWorkflowIdsRef.current = [];

      // Track text extraction promise - we'll start it after first CaseMark job
      // This allows us to use CaseMark's processing time to extract text in parallel
      let textExtractionPromise: Promise<string | null> | null = null;
      let textExtractionStarted = false;

      // Helper to start text extraction in background (for PDF files only)
      const startTextExtractionInBackground = async () => {
        if (textExtractionStarted) return; // Only start once
        textExtractionStarted = true;
        
        // Check if we already have content or it's a text file
        const sourceFilename = matter.sourceDocuments[0]?.filename || '';
        if (documentContent || isTextFile(sourceFilename)) {
          addLogEntry('info', '📝 Source text already available (skipping extraction)');
          return;
        }
        
        if (!vaultId || !objectId) {
          addLogEntry('warning', '⚠️ Cannot extract text - no vault/object ID');
          return;
        }
        
        addLogEntry('info', '📄 Starting Gemini Vision extraction in background (for quality analysis)');
        
        textExtractionPromise = (async () => {
          try {
            // Use Gemini Vision for more accurate legal document extraction
            const { extractVaultObjectWithGemini } = await import('@/lib/case-api');
            
            const extractResult = await extractVaultObjectWithGemini(
              vaultId!,
              objectId!,
              (status) => {
                // Update doc status but don't block main flow
                updateDocStatus('source', { 
                  status: 'extracting', 
                  detail: `Gemini: ${status}` 
                });
              }
            );
            
            if (extractResult.error || !extractResult.data) {
              addLogEntry('error', `Gemini Vision extraction failed: ${extractResult.error}`);
              return null;
            }
            
            const extractedContent = extractResult.data.content;
            addLogEntry('success', `✅ Gemini Vision extracted: ${extractedContent.length.toLocaleString()} chars`);
            
            // Update doc status
            updateDocStatus('source', { 
              status: 'completed', 
              detail: 'Gemini Vision extracted',
              charCount: extractedContent.length,
              pageCount: extractResult.data.pageCount
            });
            
            // Save to matter
            updateMatter({
              sourceDocuments: [{
                ...matter.sourceDocuments[0],
                content: extractedContent,
                pageCount: extractResult.data.pageCount,
                tokenEstimate: extractResult.data.tokenEstimate,
              }],
            });
            
            return extractedContent;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            addLogEntry('error', `Gemini Vision extraction exception: ${errorMsg}`);
            return null;
          }
        })();
      };

      // ═══════════════════════════════════════════════════════════════════════════
      // SEQUENTIAL JOB PROCESSING - Submit one job, wait for completion, then next
      // This is the most efficient approach - no queue contention!
      // ═══════════════════════════════════════════════════════════════════════════
      console.log('[Sequential] ═══════════════════════════════════════════');
      console.log('[Sequential] Starting sequential processing for', totalModels, 'models');
      console.log('[Sequential] Models:', modelsToRun.map(m => m.name));
      console.log('[Sequential] Existing summaries in state:', Object.keys(summaries));
      console.log('[Sequential] ═══════════════════════════════════════════');
      
      addLogEntry('info', `═══════════════════════════════════════`);
      addLogEntry('info', `🚀 Processing ${totalModels} models SEQUENTIALLY`);
      addLogEntry('info', `   (Submit → Wait → Download → Next)`);
      addLogEntry('info', `═══════════════════════════════════════`);
      
      // Check for document URL first
      if (!documentUrl) {
        const errorMsg = 'No document URL available - CaseMark API requires a presigned URL.';
        addLogEntry('error', errorMsg);
        throw new Error(errorMsg);
      }
      
      // Import the functions we need
      const { submitCaseMarkWorkflow, getCaseMarkWorkflowStatus, downloadCaseMarkResult } = await import('@/lib/case-api');
      
      // Start text extraction in background immediately
      if (!textExtractionStarted) {
        startTextExtractionInBackground();
      }
      
      // Track analysis - will run after each summary completes
      const analyzedModels = new Set<string>();
      const qualityScores: Record<string, QualityScore> = {};
      
      // Process each model SEQUENTIALLY
      let completedCount = 0;
      const INITIAL_WAIT_SECONDS = 45; // Wait 45s before first poll
      const POLL_INTERVAL_MS = 3000;   // Poll every 3s after that
      const MAX_POLL_TIME_MS = 10 * 60 * 1000; // 10 min max per model
      
      for (let i = 0; i < modelsToRun.length; i++) {
        const model = modelsToRun[i];
        
        if (cancelRequestedRef.current) {
          addLogEntry('warning', '⚠️ Processing cancelled by user');
          break;
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // CHECK: Skip if this model already has a completed summary with content
        // ═══════════════════════════════════════════════════════════════════════
        const existingSummary = summaries[model.id];
        if (existingSummary?.status === 'completed' && existingSummary?.content && existingSummary.content.length > 100) {
          addLogEntry('info', `═══════════════════════════════════════`);
          addLogEntry('info', `⏭️ [${i + 1}/${totalModels}] ${model.name} - ALREADY COMPLETE`);
          addLogEntry('info', `   └─ ${existingSummary.content.length.toLocaleString()} chars from previous run`);
          addLogEntry('info', `═══════════════════════════════════════`);
          completedCount++;
          continue; // Skip to next model
        }
        
        addLogEntry('info', `═══════════════════════════════════════`);
        addLogEntry('info', `📤 [${i + 1}/${totalModels}] ${model.name}`);
        addLogEntry('info', `═══════════════════════════════════════`);
        
        updateStep('summarize', { 
          progress: Math.round((i / totalModels) * 100),
          detail: `[${i + 1}/${totalModels}] Submitting ${model.name}...`
        });
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP A: Submit the job
        // ═══════════════════════════════════════════════════════════════════════
        const submitStartTime = Date.now();
        let workflowId: string | null = null;
        
        try {
          addLogEntry('info', `   📤 Submitting to CaseMark...`);
          const result = await submitCaseMarkWorkflow(
            workflowType,
            [documentUrl],
            model.id,
            `${matter.name} - ${model.name}`,
            (status) => addLogEntry('info', `      └─ ${status}`)
          );
          
          if (result.error || !result.data?.workflowId) {
            addLogEntry('error', `   ❌ Submit failed: ${result.error}`);
            summaries[model.id] = {
              model: model.id,
              content: '',
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              elapsedTimeMs: 0,
              costUsd: 0,
              createdAt: new Date().toISOString(),
              status: 'error',
              error: result.error || 'Submit failed',
            };
            updateMatter({ summaries: { ...summaries } });
            continue; // Move to next model
          }
          
          workflowId = result.data.workflowId;
          addLogEntry('success', `   ✓ Queued: ${workflowId}`);
          
          // Save workflow ID immediately
          summaries[model.id] = {
            model: model.id,
            content: '',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            elapsedTimeMs: 0,
            costUsd: 0,
            createdAt: new Date().toISOString(),
            status: 'generating',
            casemarkWorkflowId: workflowId,
            casemarkStartedAt: new Date().toISOString(),
          };
          updateMatter({ summaries: { ...summaries } });
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          addLogEntry('error', `   ❌ Submit exception: ${errorMsg}`);
          summaries[model.id] = {
            model: model.id,
            content: '',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            elapsedTimeMs: 0,
            costUsd: 0,
            createdAt: new Date().toISOString(),
            status: 'error',
            error: errorMsg,
          };
          updateMatter({ summaries: { ...summaries } });
          continue; // Move to next model
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP B: Wait 45 seconds before first poll
        // ═══════════════════════════════════════════════════════════════════════
        addLogEntry('info', `   ⏳ Waiting ${INITIAL_WAIT_SECONDS}s before first status check...`);
        
        for (let remaining = INITIAL_WAIT_SECONDS; remaining > 0; remaining -= 5) {
          if (cancelRequestedRef.current) break;
          updateStep('summarize', { 
            detail: `[${i + 1}/${totalModels}] ${model.name}: Waiting ${remaining}s...`
          });
          await new Promise(resolve => setTimeout(resolve, Math.min(5000, remaining * 1000)));
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP C: Poll until complete (every 3s)
        // ═══════════════════════════════════════════════════════════════════════
        addLogEntry('info', `   🔍 Polling every ${POLL_INTERVAL_MS / 1000}s...`);
        const pollStartTime = Date.now();
        let isComplete = false;
        let summaryContent = '';
        let actualStats: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; durationMs?: number } = {};
        
        while (!isComplete && (Date.now() - pollStartTime) < MAX_POLL_TIME_MS) {
          if (cancelRequestedRef.current) break;
          
          try {
            // Check status using getCaseMarkWorkflowStatus (non-blocking)
            const statusResult = await getCaseMarkWorkflowStatus(workflowId);
            
            if (statusResult.error) {
              addLogEntry('warning', `      └─ Status check error: ${statusResult.error}`);
              // Don't break - might be transient
            } else if (statusResult.data?.status === 'COMPLETED') {
              addLogEntry('success', `   ✅ CaseMark COMPLETED!`);
              isComplete = true;
              
              // Capture timing from CaseMark
              if (statusResult.data?.durationMs) {
                actualStats.durationMs = statusResult.data.durationMs;
              }
              
              // Now download the actual content
              addLogEntry('info', `   📥 Downloading result...`);
              updateStep('summarize', { 
                detail: `[${i + 1}/${totalModels}] ${model.name}: Downloading...`
              });
              
              const downloadResult = await downloadCaseMarkResult(workflowId, 'PDF');
              
              if (downloadResult.error) {
                addLogEntry('error', `   ❌ Download failed: ${downloadResult.error}`);
                summaries[model.id] = {
                  ...summaries[model.id],
                  status: 'error',
                  error: downloadResult.error,
                };
              } else if (downloadResult.data && downloadResult.data.length > 0) {
                summaryContent = downloadResult.data;
                addLogEntry('success', `   ✅ Downloaded ${summaryContent.length.toLocaleString()} chars`);
              } else {
                addLogEntry('error', `   ❌ Download returned empty content`);
                summaries[model.id] = {
                  ...summaries[model.id],
                  status: 'error',
                  error: 'Empty download',
                };
              }
              
            } else if (statusResult.data?.status === 'FAILED' || statusResult.data?.status === 'CANCELLED') {
              addLogEntry('error', `   ❌ CaseMark ${statusResult.data.status}`);
              summaries[model.id] = {
                ...summaries[model.id],
                status: 'error',
                error: `CaseMark ${statusResult.data.status}`,
              };
              updateMatter({ summaries: { ...summaries } });
              break; // Exit poll loop
              
            } else {
              // Still running - show the actual status from CaseMark API
              const casemarkStatus = statusResult.data?.status || 'Processing';
              const elapsed = Math.round((Date.now() - submitStartTime) / 1000);
              updateStep('summarize', { 
                detail: `[${i + 1}/${totalModels}] ${model.name}: ${casemarkStatus}... (${elapsed}s)`
              });
            }
            
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            addLogEntry('warning', `      └─ Poll exception: ${errorMsg}`);
          }
          
          if (!isComplete) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        }
        
        // Check for timeout
        if (!isComplete && (Date.now() - pollStartTime) >= MAX_POLL_TIME_MS) {
          addLogEntry('error', `   ❌ Timed out after ${MAX_POLL_TIME_MS / 60000} minutes`);
          summaries[model.id] = {
            ...summaries[model.id],
            status: 'error',
            error: 'Timeout waiting for CaseMark',
          };
          updateMatter({ summaries: { ...summaries } });
          continue; // Move to next model
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP D: Save completed summary
        // ═══════════════════════════════════════════════════════════════════════
        if (summaryContent && summaryContent.length > 0) {
          const totalElapsedMs = Date.now() - submitStartTime;
          const estimatedTokens = Math.ceil(summaryContent.length / 4);
          const estimatedCost = calculateCost(estimatedTokens, estimatedTokens, model.inputPricePer1M, model.outputPricePer1M);
          
          summaries[model.id] = {
            ...summaries[model.id],
            content: summaryContent,
            inputTokens: actualStats.inputTokens || estimatedTokens,
            outputTokens: actualStats.outputTokens || estimatedTokens,
            totalTokens: actualStats.totalTokens || estimatedTokens * 2,
            costUsd: actualStats.costUsd || estimatedCost,
            elapsedTimeMs: actualStats.durationMs || totalElapsedMs,
            status: 'completed',
            statsEstimated: !actualStats.costUsd,
          };
          updateMatter({ summaries: { ...summaries } });
          completedCount++;
          
          addLogEntry('success', `   ✓ ${model.name} complete: ${summaryContent.length.toLocaleString()} chars in ${Math.round(totalElapsedMs / 1000)}s`);
        }
      }
      
      // All models processed
      addLogEntry('info', `═══════════════════════════════════════`);
      addLogEntry('info', `✓ ${completedCount}/${totalModels} summaries generated`);
      addLogEntry('info', `═══════════════════════════════════════`);
      
      updateStep('summarize', { status: 'completed', progress: 100 });
      
      // ═══════════════════════════════════════════════════════════════════════════
      // STEP 3: Quality Analysis (run for all completed summaries)
      // ═══════════════════════════════════════════════════════════════════════════
      
      // Start analysis phase UI
      setCurrentPhase('analyze');
      updateStep('analyze', { status: 'running', progress: 0 });
      updateMatter({ status: 'analyzing' });
      
      // Wait for source text in background (don't block!)
      let sourceTextReady = !!documentContent;
      if (textExtractionPromise && !sourceTextReady) {
        (textExtractionPromise as Promise<string | null>).then((extracted: string | null) => {
          if (extracted) {
            documentContent = extracted;
            sourceTextReady = true;
            addLogEntry('success', '✅ Source text ready for analysis');
          }
        });
      }
      
      // Helper to extract text and analyze a single summary with timeout
      const extractAndAnalyze = async (summary: SummaryResult): Promise<void> => {
        const modelId = summary.model;
        const model = TEST_MODELS.find(m => m.id === modelId);
        const modelName = model?.name || modelId;
        
        if (analyzedModels.has(modelId)) {
          addLogEntry('info', `⏭️ ${modelName} already analyzed, skipping`);
          return;
        }
        analyzedModels.add(modelId);
        
        // Step 1: Extract text if needed (with timeout)
        let summaryContent = summary.content;
        const workflowId = summary.casemarkWorkflowId;
        
        if ((summary.status === 'completed_no_download' || !summaryContent || summaryContent.length < 100) && workflowId) {
          addLogEntry('info', `📥 Auto-downloading ${modelName}...`);
          
          // Create a timeout promise - increased to 5 minutes since Vault extraction can take a while
          const timeoutMs = 300000; // 5 minute timeout for download + text extraction
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error(`Download timeout after ${timeoutMs/1000}s`)), timeoutMs)
          );
          
          try {
            const { downloadCaseMarkResult } = await import('@/lib/case-api');
            const downloadResult = await Promise.race([
              downloadCaseMarkResult(workflowId, 'PDF'),
              timeoutPromise
            ]);
            
            if (downloadResult.error) {
              addLogEntry('error', `   └─ ${modelName}: Download error: ${downloadResult.error}`);
              // Mark as error so we don't retry forever
              summaries[modelId] = { ...summaries[modelId], status: 'error', error: downloadResult.error };
              updateMatter({ summaries: { ...summaries } });
              return;
            }
            
            if (downloadResult.data && downloadResult.data.length > 0) {
              summaryContent = downloadResult.data;
              // Use actual stats from summary if available, otherwise estimate
              const hasActualStats = !!(summary.inputTokens && summary.inputTokens > 0 && summary.costUsd && summary.costUsd > 0);
              const estimatedTokens = Math.ceil(summaryContent.length / 4);
              const estimatedCost = model ? calculateCost(estimatedTokens, estimatedTokens, model.inputPricePer1M, model.outputPricePer1M) : 0;
              
              summaries[modelId] = {
                ...summaries[modelId], // Use current state, not stale summary param
                content: summaryContent,
                inputTokens: hasActualStats ? summary.inputTokens : estimatedTokens,
                outputTokens: hasActualStats ? summary.outputTokens : estimatedTokens,
                totalTokens: hasActualStats ? summary.totalTokens : estimatedTokens * 2,
                costUsd: hasActualStats ? summary.costUsd : estimatedCost,
                status: 'completed',
                statsEstimated: !hasActualStats,
              };
              updateMatter({ summaries: { ...summaries } });
              addLogEntry('success', `   └─ ${modelName}: Downloaded ${summaryContent.length.toLocaleString()} chars${!hasActualStats ? ' (stats estimated)' : ''}`);
            } else {
              addLogEntry('error', `   └─ ${modelName}: Download returned empty content`);
              summaries[modelId] = { ...summaries[modelId], status: 'error', error: 'Empty download' };
              updateMatter({ summaries: { ...summaries } });
              return;
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            addLogEntry('error', `   └─ ${modelName}: Download failed: ${errorMsg}`);
            summaries[modelId] = { ...summaries[modelId], status: 'error', error: errorMsg };
            updateMatter({ summaries: { ...summaries } });
            return;
          }
        } else if (!workflowId) {
          addLogEntry('error', `   └─ ${modelName}: No workflow ID - cannot download`);
          return;
        }
        
        if (!summaryContent || summaryContent.length < 100) {
          addLogEntry('warning', `   └─ ${modelName}: Content too short (${summaryContent?.length || 0} chars) - skipping analysis`);
          return;
        }
        
        // Step 2: Run quality analysis
        addLogEntry('info', `🔍 Analyzing ${modelName}...`);
        try {
          const summaryTypeName = SUMMARY_TYPE_INFO[matter.summaryType]?.label || matter.summaryType;
          const hasControl = !!matter.controlSummary?.content;
          const basePrompt = hasControl ? QUALITY_ANALYSIS_PROMPT : QUALITY_ANALYSIS_PROMPT_NO_CONTROL;
          const analysisPrompt = basePrompt.replace('{summary_type_name}', summaryTypeName);
          
          let userContent: string;
          if (hasControl) {
            userContent = `=== ORIGINAL SOURCE DOCUMENT (GOLD STANDARD) ===\n${documentContent}\n\n=== TEST SUMMARY TO EVALUATE ===\nModel: ${modelName}\n${summaryContent}\n\n=== CONTROL SUMMARY (REFERENCE ONLY) ===\n${matter.controlSummary!.content}`;
          } else {
            userContent = `ORIGINAL DOCUMENT:\n${documentContent}\n\nSUMMARY TO EVALUATE:\nModel: ${modelName}\n${summaryContent}`;
          }
          
          const result = await createChatCompletion(JUDGE_MODEL.id, [
            { role: 'system', content: analysisPrompt },
            { role: 'user', content: userContent },
          ]);
          
          if (result.data?.choices?.[0]) {
            const content = result.data.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const normalizeScore = (s: number) => s <= 10 ? s * 10 : Math.min(s, 100);
              const parseCat = (v: unknown, fb = 0) => {
                if (typeof v === 'number') return { score: normalizeScore(v), rationale: '', examples: [] };
                if (typeof v === 'object' && v !== null) {
                  const o = v as Record<string, unknown>;
                  return { score: normalizeScore(typeof o.score === 'number' ? o.score : fb), rationale: (o.rationale as string) || '', examples: Array.isArray(o.examples) ? o.examples : [] };
                }
                return { score: normalizeScore(fb), rationale: '', examples: [] };
              };
              
              const analysisCost = calculateCost(result.data.usage.prompt_tokens, result.data.usage.completion_tokens, JUDGE_MODEL.inputPricePer1M, JUDGE_MODEL.outputPricePer1M);
              const overallScore = normalizeScore(parsed.overall_score || 0);
              
              qualityScores[modelId] = {
                model: modelId,
                factualAccuracy: parseCat(parsed.factual_accuracy),
                pageLineAccuracy: parseCat(parsed.page_line_accuracy),
                relevance: parseCat(parsed.relevance),
                comprehensiveness: parseCat(parsed.comprehensiveness),
                legalUtility: parseCat(parsed.legal_utility),
                overallScore,
                strengths: parsed.strengths || [],
                weaknesses: parsed.weaknesses || [],
                specificErrors: Array.isArray(parsed.specific_errors) ? parsed.specific_errors.map((e: Record<string, unknown>) => ({
                  type: e.type || 'factual', severity: e.severity || 'minor', summaryExcerpt: e.summary_excerpt || '',
                  sourceReference: e.source_reference || '', explanation: e.explanation || '', correction: e.correction || '',
                })) : [],
                missingItems: parsed.missing_items || [],
                controlComparison: parsed.control_comparison || '',
                missingFromTest: parsed.missing_from_test || [],
                extraInTest: parsed.extra_in_test || [],
                analysisNotes: parsed.analysis_notes || '',
                recommendation: parsed.recommendation || '',
                costUsd: analysisCost,
                costEffectiveness: summary.costUsd > 0 ? overallScore / summary.costUsd : 0,
              };
              
              updateMatter({ qualityScores: { ...qualityScores } });
              addLogEntry('success', `   └─ ${modelName}: ${overallScore}/100`);
              
              setJustAnalyzedModelId(modelId);
              setTimeout(() => setJustAnalyzedModelId(null), 1500);
            }
          }
        } catch (error) {
          addLogEntry('error', `   └─ ${modelName} analysis error: ${error instanceof Error ? error.message : 'Error'}`);
        }
      };
      
      // ═══════════════════════════════════════════════════════════════════════════
      // SEQUENTIAL QUALITY ANALYSIS - Analyze all completed summaries
      // ═══════════════════════════════════════════════════════════════════════════
      
      // Get all completed summaries that need analysis
      const summariesForAnalysis = Object.values(summaries).filter(
        s => s.status === 'completed' && s.content && s.content.length > 100
      );
      
      addLogEntry('info', `═══════════════════════════════════════`);
      addLogEntry('info', `🔬 Analyzing ${summariesForAnalysis.length} summaries with GPT-5.2`);
      addLogEntry('info', `═══════════════════════════════════════`);
      
      // Run analysis sequentially for each summary
      for (let i = 0; i < summariesForAnalysis.length; i++) {
        if (cancelRequestedRef.current) break;
        
        const summary = summariesForAnalysis[i];
        const model = TEST_MODELS.find(m => m.id === summary.model);
        const modelName = model?.name || summary.model;
        
        updateStep('analyze', { 
          progress: Math.round((i / summariesForAnalysis.length) * 100),
          detail: `[${i + 1}/${summariesForAnalysis.length}] Analyzing ${modelName}...`
        });
        
        await extractAndAnalyze(summary);
      }
      
      updateStep('analyze', { 
        progress: 100,
        detail: `${Object.keys(qualityScores).length}/${summariesForAnalysis.length} analyzed`
      });
      
      addLogEntry('info', `✅ Quality analysis complete: ${Object.keys(qualityScores).length} summaries scored`);

      // Clear current model tracking
      setCurrentModelId(null);
      setCurrentModelStartTime(null);
      
      updateStep('summarize', { status: 'completed', progress: 100, detail: undefined });
      
      // ═══════════════════════════════════════════════════════════════════════════
      // CALCULATE COMPARISON SCORES vs CONTROL
      // ═══════════════════════════════════════════════════════════════════════════
      const controlModelId = 'casemark/default';
      const controlScore = qualityScores[controlModelId];
      const controlSummaryCost = summaries[controlModelId]?.costUsd || 0;
      
      if (controlScore) {
        addLogEntry('info', `📊 Calculating comparison scores vs Control...`);
        
        for (const [modelId, score] of Object.entries(qualityScores)) {
          const summaryCost = summaries[modelId]?.costUsd || 0;
          
          // Calculate vs Control Score (positive = better than control)
          const vsControlScore = score.overallScore - controlScore.overallScore;
          
          // Calculate cost savings (positive = cheaper)
          const costSavingsPercent = controlSummaryCost > 0 
            ? Math.round(((controlSummaryCost - summaryCost) / controlSummaryCost) * 100)
            : 0;
          
          // Value Score: Quality relative to control + cost savings benefit
          // If quality is same but 80% cheaper, that's a great value!
          // Formula: (quality_score / 100) * (1 + cost_savings_factor)
          const costSavingsFactor = Math.max(0, costSavingsPercent) / 100; // 0-1 range
          const qualityFactor = score.overallScore / 100;
          const valueScore = Math.round(qualityFactor * (1 + costSavingsFactor * 0.5) * 100);
          
          // Update the score with comparison metrics
          qualityScores[modelId] = {
            ...score,
            vsControlScore,
            costSavingsPercent,
            valueScore,
          };
          
          const model = TEST_MODELS.find(m => m.id === modelId);
          if (modelId !== controlModelId) {
            addLogEntry('info', `   └─ ${model?.name}: ${vsControlScore >= 0 ? '+' : ''}${vsControlScore} vs Control, ${costSavingsPercent}% cost savings, Value: ${valueScore}`);
          }
        }
        
        updateMatter({ qualityScores: { ...qualityScores } });
      }
      
      const finalCompletedCount = Object.values(summaries).filter(s => s.status === 'completed').length;
      const failedCount = Object.values(summaries).filter(s => s.status === 'error').length;
      debugLogger.info(`📊 Processing complete`, { completed: finalCompletedCount, failed: failedCount, analyzed: Object.keys(qualityScores).length }, 'processing');
      
      addLogEntry('info', `═══════════════════════════════════════`);
      addLogEntry('info', `🎉 All processing complete!`);
      addLogEntry('info', `   Summaries: ${finalCompletedCount} completed, ${failedCount} failed`);
      addLogEntry('info', `   Analyses: ${Object.keys(qualityScores).length} scored`);
      addLogEntry('info', `═══════════════════════════════════════`);

      // Skip duplicate analysis code - already done in parallel above
      const skipDuplicateBlock = true;
      if (!skipDuplicateBlock) {
      const qualityScoresDummy: Record<string, QualityScore> = {};
      // Use the local summaries variable (not matter.summaries) to ensure we have latest
      const completedSummaries = Object.values(summaries).filter(
        (s) => s.status === 'completed' && s.content
      );
      
      debugLogger.info(`📋 Found ${completedSummaries.length} completed summaries for analysis`, {
        models: completedSummaries.map(s => TEST_MODELS.find(m => m.id === s.model)?.name || s.model)
      }, 'processing');
      addLogEntry('info', `🚀 Analyzing ${completedSummaries.length} summaries in parallel...`);

      // Track completion count for progress
      let analysisCompletedCount = 0;
      const analysisTotalCount = completedSummaries.length;

      // Normalize score from 0-10 to 0-100 if LLM returned old scale
      const normalizeScore = (score: number): number => {
        if (score <= 10) return score * 10; // Convert 0-10 to 0-100
        return Math.min(score, 100); // Cap at 100
      };

      // Helper to parse category score (handles both old and new format)
      const parseCategoryScore = (value: unknown, fallback = 0) => {
        if (typeof value === 'number') {
          return { score: normalizeScore(value), rationale: '', examples: [] };
        }
        if (typeof value === 'object' && value !== null) {
          const obj = value as Record<string, unknown>;
          const rawScore = typeof obj.score === 'number' ? obj.score : fallback;
          return {
            score: normalizeScore(rawScore),
            rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
            examples: Array.isArray(obj.examples) ? obj.examples : [],
          };
        }
        return { score: normalizeScore(fallback), rationale: '', examples: [] };
      };

      const analysisPrompt = QUALITY_ANALYSIS_PROMPT.replace(
        '{summary_type_name}',
        SUMMARY_TYPE_INFO[matter.summaryType]?.label || matter.summaryType
      );

      // Create analysis promises for parallel execution
      const analysisPromises = completedSummaries.map(async (summary) => {
        // Check for cancellation
        if (cancelRequestedRef.current) {
          return null;
        }

        const modelName = TEST_MODELS.find((m) => m.id === summary.model)?.name || summary.model;
        
        debugLogger.info(`🔍 Starting analysis for ${modelName}...`, {}, 'processing');
        addLogEntry('info', `   └─ Analyzing ${modelName}...`);

        // Build analysis content with or without control
        let analysisContent: string;
        if (controlContent) {
          analysisContent = `=== ORIGINAL SOURCE DOCUMENT (THIS IS THE GOLD STANDARD - verify all facts against this) ===
${documentContent}

=== TEST SUMMARY TO EVALUATE (Score this based on accuracy to SOURCE above) ===
Model: ${modelName}
${summary.content}

=== CONTROL SUMMARY (Current production output - FOR REFERENCE ONLY, may have its own errors) ===
${controlContent}`;
        } else {
          analysisContent = `ORIGINAL DOCUMENT:\n${documentContent}\n\nSUMMARY TO EVALUATE:\n${summary.content}`;
        }

        try {
          const startTime = Date.now();
          const result = await createChatCompletion(JUDGE_MODEL.id, [
            { role: 'system', content: analysisPrompt },
            {
              role: 'user',
              content: analysisContent,
            },
          ]);

          const elapsedTime = Date.now() - startTime;
          
          if (result.data && result.data.choices[0]) {
            const content = result.data.choices[0].message.content;
            debugLogger.info(`✅ ${modelName} analysis complete`, { 
              elapsedMs: elapsedTime,
              responseLength: content.length,
              tokens: result.data.usage?.total_tokens 
            }, 'processing');
            
            // Parse JSON from response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              
              const analysisCost = calculateCost(
                result.data.usage.prompt_tokens,
                result.data.usage.completion_tokens,
                JUDGE_MODEL.inputPricePer1M,
                JUDGE_MODEL.outputPricePer1M
              );

              // Parse specific errors
              const specificErrors = Array.isArray(parsed.specific_errors)
                ? parsed.specific_errors.map((e: Record<string, unknown>) => ({
                    type: e.type || 'factual',
                    severity: e.severity || 'minor',
                    summaryExcerpt: e.summary_excerpt || '',
                    sourceReference: e.source_reference || '',
                    explanation: e.explanation || '',
                    correction: e.correction || '',
                  }))
                : [];

              const rawOverallScore = parsed.overall_score || 0;
              const overallScore = normalizeScore(rawOverallScore);
              
              debugLogger.info(`📈 ${modelName} score: ${rawOverallScore} → ${overallScore}/100`, {
                factual: parsed.factual_accuracy?.score || parsed.factual_accuracy,
                citations: parsed.page_line_accuracy?.score || parsed.page_line_accuracy,
                relevance: parsed.relevance?.score || parsed.relevance,
                errors: (parsed.specific_errors || []).length
              }, 'processing');

              const score: QualityScore = {
                model: summary.model,
                factualAccuracy: parseCategoryScore(parsed.factual_accuracy),
                pageLineAccuracy: parseCategoryScore(parsed.page_line_accuracy),
                relevance: parseCategoryScore(parsed.relevance),
                comprehensiveness: parseCategoryScore(parsed.comprehensiveness),
                legalUtility: parseCategoryScore(parsed.legal_utility),
                overallScore,
                strengths: parsed.strengths || [],
                weaknesses: parsed.weaknesses || [],
                specificErrors,
                missingItems: parsed.missing_items || [],
                // Control comparison (can be string or object)
                controlComparison: typeof parsed.control_comparison === 'object' && parsed.control_comparison !== null
                  ? {
                      summary: parsed.control_comparison.summary || '',
                      testBetterThanControl: parsed.control_comparison.test_better_than_control || [],
                      testWorseThanControl: parsed.control_comparison.test_worse_than_control || [],
                      testIncludesControlMissing: parsed.control_comparison.test_includes_control_missing || [],
                      controlIncludesTestMissing: parsed.control_comparison.control_includes_test_missing || [],
                    }
                  : (parsed.control_comparison || ''),
                missingFromTest: parsed.missing_from_test || [],
                extraInTest: parsed.extra_in_test || [],
                analysisNotes: parsed.analysis_notes || '',
                recommendation: parsed.recommendation || '',
                costUsd: analysisCost,
                costEffectiveness:
                  summary.costUsd > 0 ? overallScore / summary.costUsd : 0,
              };

              // Update progress
              analysisCompletedCount++;
              const progress = Math.round((analysisCompletedCount / analysisTotalCount) * 100);
              updateStep('analyze', {
                progress,
                detail: `${analysisCompletedCount}/${analysisTotalCount} analyzed`,
              });
              addLogEntry('success', `   └─ ${modelName}: ${overallScore}/100`, `${(elapsedTime / 1000).toFixed(1)}s`);
              
              // Flash highlight effect for analysis
              setJustAnalyzedModelId(summary.model);
              setTimeout(() => setJustAnalyzedModelId(null), 1500);

              return { model: summary.model, score };
            } else {
              debugLogger.warn(`⚠️ ${modelName}: No JSON found in response`, { 
                responsePreview: content.substring(0, 200) 
              }, 'processing');
              addLogEntry('warning', `   └─ ${modelName}: No valid JSON in response`);
              analysisCompletedCount++;
              return null;
            }
          } else {
            debugLogger.error(`❌ ${modelName} analysis failed`, { 
              error: result.error || 'No response data' 
            }, 'processing');
            addLogEntry('error', `   └─ ${modelName}: ${result.error || 'No response'}`);
            analysisCompletedCount++;
            return null;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          debugLogger.error(`💥 ${modelName} analysis exception: ${errorMsg}`, {}, 'processing');
          addLogEntry('error', `   └─ ${modelName}: ${errorMsg}`);
          console.error('Analysis error:', error);
          analysisCompletedCount++;
          return null;
        }
      });

      // Wait for all analyses to complete in parallel
      const results = await Promise.all(analysisPromises);
      
      // Collect successful results
      for (const result of results) {
        if (result && result.score) {
          qualityScores[result.model] = result.score;
        }
      }
      
      // Final update with all scores
      updateMatter({ qualityScores });

      // Clear analysis tracking
      setAnalysisModelId(null);
      setCurrentModelStartTime(null);
      setCurrentPhase(null);
      
      debugLogger.info('🎉 Processing complete!', { 
        totalScores: Object.keys(qualityScores).length,
        scores: Object.entries(qualityScores).map(([model, score]) => ({
          model: TEST_MODELS.find(m => m.id === model)?.name || model,
          score: score.overallScore
        }))
      }, 'processing');
      
      updateStep('analyze', { status: 'completed', progress: 100, detail: undefined });
      updateMatter({ status: 'completed' });
      } // End of skipDuplicateBlock if statement

      // Clear analysis tracking (after parallel processing)
      setAnalysisModelId(null);
      setCurrentModelStartTime(null);
      setCurrentPhase(null);
      
      updateStep('analyze', { status: 'completed', progress: 100, detail: undefined });
      updateMatter({ status: 'completed', qualityScores });
    } catch (error) {
      // Don't show error if cancelled
      if (cancelRequestedRef.current) {
        debugLogger.info('🛑 Processing was cancelled', {}, 'processing');
        return;
      }
      
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      debugLogger.error(`💥 Processing failed: ${errorMsg}`, {}, 'processing');
      console.error('Processing error:', error);
      updateMatter({
        status: 'error',
        error: errorMsg,
      });
      toast({
        title: 'Processing Failed',
        description: errorMsg,
        variant: 'destructive',
      });
    } finally {
      // Reset cancellation flag
      cancelRequestedRef.current = false;
      activeWorkflowIdsRef.current = [];
      
      setProcessing(false);
      setCurrentActivity('');
      setCurrentPhase(null);
      debugLogger.info('🏁 Processing ended', {}, 'processing');
      addLogEntry('info', 'Processing pipeline completed');
    }
  };

  // Run only specific missing models (preserves existing summaries)
  const runMissingModels = async (modelIds: string[]) => {
    if (!matter) return;

    setProcessing(true);
    const modelsToRun = TEST_MODELS.filter(m => modelIds.includes(m.id));
    
    setSteps([
      { id: 'summarize', label: `Generate ${modelsToRun.length} Missing Summaries`, status: 'running', progress: 0 },
      { id: 'analyze', label: 'Quality Analysis', status: 'pending' },
    ]);

    const updateStep = (stepId: string, updates: Partial<ProcessingStep>) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, ...updates } : s))
      );
    };

    const updateMatter = (updates: Partial<Matter>) => {
      setMatter((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, ...updates };
        saveMatter(updated);
        return updated;
      });
    };

    try {
      updateMatter({ status: 'summarizing' });
      addLogEntry('info', `Running ${modelsToRun.length} missing models via CaseMark API`);

      // Get document URL from existing vault
      const vaultId = matter.vaultId;
      const objectId = matter.sourceDocuments[0]?.objectId;
      const documentText = matter.sourceDocuments[0]?.content || ''; // For quality analysis
      
      if (!vaultId || !objectId) {
        const errorMsg = 'Cannot run missing models - no vault/object ID for source document';
        addLogEntry('error', errorMsg);
        toast({
          title: 'CaseMark API Error',
          description: errorMsg,
          variant: 'destructive',
        });
        throw new Error(errorMsg);
      }

      // Get presigned URL for CaseMark
      const urlResult = await getVaultPresignedUrl(vaultId, objectId);
      if (!urlResult.data?.url) {
        const errorMsg = 'Failed to get document URL for CaseMark API';
        addLogEntry('error', errorMsg);
        throw new Error(errorMsg);
      }
      const documentUrl = urlResult.data.url;

      // summaryType IS the CaseMark workflow type now (e.g., 'DEPOSITION_ANALYSIS')
      const workflowType: CaseMarkWorkflowType = matter.summaryType;

      // Generate summaries only for missing models via CaseMark
      const summaries = { ...matter.summaries };

      // Reset cancellation state
      cancelRequestedRef.current = false;

      for (let i = 0; i < modelsToRun.length; i++) {
        // Check for cancellation
        if (cancelRequestedRef.current) {
          addLogEntry('warning', `Cancelled before ${modelsToRun[i].name}`);
          break;
        }

        const model = modelsToRun[i];
        const progress = ((i + 1) / modelsToRun.length) * 100;
        updateStep('summarize', {
          progress,
          detail: `CaseMark: ${model.name} (${i + 1}/${modelsToRun.length})`,
        });
        addLogEntry('info', `CaseMark API: ${workflowType} with ${model.name}`);

        try {
          const startTime = Date.now();
          let savedWorkflowId: string | undefined;

          const result = await generateCaseMarkSummary(
            workflowType,
            [documentUrl],
            model.id,
            `${matter.name} - ${model.name}`,
            (status) => {
              updateStep('summarize', {
                progress,
                detail: `${model.name}: ${status}`,
              });
            },
            // Save workflow ID immediately
            (workflowId) => {
              savedWorkflowId = workflowId;
              addLogEntry('info', `   └─ Workflow ID: ${workflowId}`);
              
              // Save to matter immediately
              const partialSummary: SummaryResult = {
                model: model.id,
                content: '',
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                elapsedTimeMs: 0,
                costUsd: 0,
                createdAt: new Date().toISOString(),
                status: 'generating',
                casemarkWorkflowId: workflowId,
                casemarkStartedAt: new Date().toISOString(),
              };
              
              setMatter(prev => {
                if (!prev) return prev;
                const updated = {
                  ...prev,
                  summaries: { ...prev.summaries, [model.id]: partialSummary },
                  updatedAt: new Date().toISOString(),
                };
                saveMatter(updated);
                return updated;
              });
            }
          );

          const elapsedTimeMs = Date.now() - startTime;
          const workflowId = result.data?.workflowId || savedWorkflowId;

          if (result.error || !result.data?.content) {
            addLogEntry('error', `${model.name} failed: ${result.error}${workflowId ? ` (ID: ${workflowId})` : ''}`);
            summaries[model.id] = {
              model: model.id,
              content: '',
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              elapsedTimeMs,
              status: 'error',
              error: result.error || 'CaseMark workflow failed',
              createdAt: new Date().toISOString(),
              casemarkWorkflowId: workflowId,
            };
          } else {
            const estimatedTokens = Math.ceil(result.data.content.length / 4);
            const costUsd = calculateCost(
              estimatedTokens,
              estimatedTokens,
              model.inputPricePer1M,
              model.outputPricePer1M
            );

            addLogEntry('success', `${model.name} completed`, `${(elapsedTimeMs / 1000).toFixed(1)}s`);
            summaries[model.id] = {
              model: model.id,
              content: result.data.content,
              inputTokens: estimatedTokens,
              outputTokens: estimatedTokens,
              totalTokens: estimatedTokens * 2,
              costUsd,
              elapsedTimeMs,
              status: 'completed',
              createdAt: new Date().toISOString(),
              casemarkWorkflowId: workflowId,
            };
          }
        } catch (error) {
          console.error(`Error with ${model.name}:`, error);
          addLogEntry('error', `${model.name} exception: ${error instanceof Error ? error.message : 'Unknown'}`);
          summaries[model.id] = {
            model: model.id,
            content: '',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            elapsedTimeMs: 0,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            createdAt: new Date().toISOString(),
          };
        }

        updateMatter({ summaries });
      }

      updateStep('summarize', { status: 'completed', progress: 100, detail: undefined });

      // Quality analysis for ALL completed summaries (including new ones)
      updateStep('analyze', { status: 'running', progress: 0 });
      updateMatter({ status: 'analyzing' });

      const allCompletedSummaries = Object.values(summaries).filter(s => s.status === 'completed');
      const qualityScores = { ...matter.qualityScores };

      for (let i = 0; i < allCompletedSummaries.length; i++) {
        // Check for cancellation
        if (cancelRequestedRef.current) {
          addLogEntry('warning', `Cancelled before analyzing ${allCompletedSummaries[i].model}`);
          break;
        }

        const summary = allCompletedSummaries[i];
        
        // Skip if already analyzed
        if (qualityScores[summary.model]) {
          continue;
        }

        const model = TEST_MODELS.find((m) => m.id === summary.model);
        const progress = ((i + 1) / allCompletedSummaries.length) * 100;
        updateStep('analyze', {
          progress,
          detail: `Analyzing ${model?.name || summary.model}`,
        });

        try {
          const analysisResponse = await createChatCompletion(JUDGE_MODEL.id, [
            { role: 'system', content: QUALITY_ANALYSIS_PROMPT },
            { role: 'user', content: `SOURCE DOCUMENT:\n${documentText}\n\nSUMMARY TO EVALUATE:\n${summary.content}` },
          ]);

          if (analysisResponse.data?.choices?.[0]?.message?.content) {
            let analysisContent = analysisResponse.data.choices[0].message.content;
            const jsonMatch = analysisContent.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
              analysisContent = jsonMatch[1];
            }
            const parsed = JSON.parse(analysisContent);
            const analysisCost = calculateCost(
              analysisResponse.data?.usage?.prompt_tokens || 0,
              analysisResponse.data?.usage?.completion_tokens || 0,
              JUDGE_MODEL.inputPricePer1M,
              JUDGE_MODEL.outputPricePer1M
            );

            // Normalize score from 0-10 to 0-100 if LLM returned old scale
            const normalizeScore = (score: number): number => {
              if (score <= 10) return score * 10; // Convert 0-10 to 0-100
              return Math.min(score, 100); // Cap at 100
            };

            const parseCategoryScore = (value: unknown, fallback = 0) => {
              if (typeof value === 'number') {
                return { score: normalizeScore(value), rationale: '', examples: [] };
              }
              if (typeof value === 'object' && value !== null) {
                const obj = value as Record<string, unknown>;
                const rawScore = typeof obj.score === 'number' ? obj.score : fallback;
                return {
                  score: normalizeScore(rawScore),
                  rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
                  examples: Array.isArray(obj.examples) ? obj.examples : [],
                };
              }
              return { score: normalizeScore(fallback), rationale: '', examples: [] };
            };

            const specificErrors = Array.isArray(parsed.specific_errors)
              ? parsed.specific_errors.map((e: Record<string, unknown>) => ({
                  type: e.type || 'factual',
                  severity: e.severity || 'minor',
                  summaryExcerpt: e.summary_excerpt || '',
                  sourceReference: e.source_reference || '',
                  explanation: e.explanation || '',
                  correction: e.correction || '',
                }))
              : [];

            const rawOverallScore = parsed.overall_score || 0;
            const overallScore = normalizeScore(rawOverallScore);

            qualityScores[summary.model] = {
              model: summary.model,
              factualAccuracy: parseCategoryScore(parsed.factual_accuracy),
              pageLineAccuracy: parseCategoryScore(parsed.page_line_accuracy),
              relevance: parseCategoryScore(parsed.relevance),
              comprehensiveness: parseCategoryScore(parsed.comprehensiveness),
              legalUtility: parseCategoryScore(parsed.legal_utility),
              overallScore,
              strengths: parsed.strengths || [],
              weaknesses: parsed.weaknesses || [],
              specificErrors,
              missingItems: parsed.missing_items || [],
              // Control comparison (can be string or object)
              controlComparison: typeof parsed.control_comparison === 'object' && parsed.control_comparison !== null
                ? {
                    summary: parsed.control_comparison.summary || '',
                    testBetterThanControl: parsed.control_comparison.test_better_than_control || [],
                    testWorseThanControl: parsed.control_comparison.test_worse_than_control || [],
                    testIncludesControlMissing: parsed.control_comparison.test_includes_control_missing || [],
                    controlIncludesTestMissing: parsed.control_comparison.control_includes_test_missing || [],
                  }
                : (parsed.control_comparison || ''),
              missingFromTest: parsed.missing_from_test || [],
              extraInTest: parsed.extra_in_test || [],
              analysisNotes: parsed.analysis_notes || '',
              recommendation: parsed.recommendation || '',
              costUsd: analysisCost,
              costEffectiveness: summary.costUsd > 0 ? overallScore / summary.costUsd : 0,
            };
          }
        } catch (error) {
          console.error('Analysis error:', error);
        }

        updateMatter({ qualityScores });
      }

      updateStep('analyze', { status: 'completed', progress: 100, detail: undefined });
      updateMatter({ status: 'completed' });
      addLogEntry('success', 'All models processed and analyzed');
    } catch (error) {
      // Don't show error if cancelled
      if (cancelRequestedRef.current) {
        debugLogger.info('🛑 Processing was cancelled', {}, 'processing');
        return;
      }
      
      console.error('Processing error:', error);
      addLogEntry('error', `Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      updateMatter({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      toast({
        title: 'Processing Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      // Reset cancellation flag
      cancelRequestedRef.current = false;
      
      setProcessing(false);
      setCurrentActivity('');
      setCurrentPhase(null);
    }
  };

  const downloadSummary = (modelId: string) => {
    if (!matter) return;
    const summary = matter.summaries[modelId];
    if (!summary) return;

    const model = TEST_MODELS.find((m) => m.id === modelId);
    // CaseMark summaries are PDFs - save extracted text as .txt
    const filename = `${matter.name.replace(/,?\s+/g, '_')}-${model?.provider}_${model?.name.replace(/\s+/g, '-')}.txt`;

    const blob = new Blob([summary.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // View/download the actual CaseMark PDF (not extracted text)
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);
  
  const viewPdf = async (modelId: string) => {
    if (!matter) return;
    const summary = matter.summaries[modelId];
    if (!summary?.casemarkWorkflowId) {
      toast({ title: 'No PDF available', description: 'This summary has no CaseMark workflow ID.', variant: 'destructive' });
      return;
    }
    
    setDownloadingPdf(modelId);
    const model = TEST_MODELS.find((m) => m.id === modelId);
    toast({ title: 'Downloading PDF...', description: `Getting ${model?.name.replace(/[^\x00-\x7F]/g, '')} summary from CaseMark` });
    
    try {
      // Call our server endpoint to get the PDF
      const response = await fetch(`/api/casemark/workflow/${summary.casemarkWorkflowId}/pdf`);
      
      // Check content type first
      const contentType = response.headers.get('content-type');
      
      if (!response.ok) {
        // Try to parse error as JSON
        const text = await response.text();
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorData = JSON.parse(text);
          errorMessage = errorData.error || errorMessage;
        } catch {
          errorMessage = text || errorMessage;
        }
        throw new Error(errorMessage);
      }
      
      // Verify it's actually a PDF
      if (!contentType?.includes('application/pdf')) {
        const text = await response.text();
        console.error('Expected PDF but got:', contentType, text.substring(0, 200));
        throw new Error(`Expected PDF but got ${contentType}`);
      }
      
      // Get the PDF blob directly
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      // Open in new tab
      window.open(url, '_blank');
      
      // Clean filename - remove non-ASCII chars like emojis
      const cleanModelName = model?.name.replace(/[^\x00-\x7F]/g, '').trim() || 'summary';
      const cleanMatterName = matter.name.replace(/[^\x00-\x7F]/g, '').replace(/,?\s+/g, '_');
      const filename = `${cleanMatterName}-${model?.provider}_${cleanModelName.replace(/\s+/g, '-')}.pdf`;
      
      toast({ title: 'PDF opened', description: 'The PDF opened in a new tab.' });
    } catch (error) {
      toast({ 
        title: 'Failed to get PDF', 
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive' 
      });
    } finally {
      setDownloadingPdf(null);
    }
  };

  const downloadAllSummaries = async () => {
    if (!matter) return;
    
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    Object.entries(matter.summaries).forEach(([modelId, summary]) => {
      if (summary.status === 'completed' && summary.content) {
        const model = TEST_MODELS.find((m) => m.id === modelId);
        // CaseMark summaries are PDFs - save extracted text as .txt
        const filename = `${matter.name.replace(/,?\s+/g, '_')}-${model?.provider}_${model?.name.replace(/\s+/g, '-')}.txt`;
        zip.file(filename, summary.content);
      }
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${matter.name.replace(/\s+/g, '_')}_summaries.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Chat with the Judge (GPT-5.2) about the results
  const sendChatMessage = async () => {
    if (!chatInput.trim() || chatLoading || !matter) return;
    
    const userMessage = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setChatLoading(true);
    
    // Scroll to bottom
    setTimeout(() => {
      chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 100);
    
    try {
      // Build context with all the analysis results
      const selectedModels = matter.modelsToTest
        ? TEST_MODELS.filter((m) => matter.modelsToTest!.includes(m.id))
        : TEST_MODELS;
      
      // Find control model for cost comparisons
      const controlModel = TEST_MODELS.find(m => m.isControl);
      const controlSummary = controlModel ? matter.summaries[controlModel.id] : null;
      const controlScore = controlModel ? matter.qualityScores[controlModel.id] : null;
      const controlCost = controlSummary?.costUsd || 0;
      
      const resultsContext = selectedModels.map(model => {
        const summary = matter.summaries[model.id];
        const score = matter.qualityScores[model.id];
        
        if (!score) return null;
        
        const cost = summary?.costUsd || 0;
        const costVsControl = controlCost > 0 ? ((controlCost - cost) / controlCost * 100) : 0;
        const costComparison = model.isControl 
          ? '(BASELINE)' 
          : costVsControl > 0 
            ? `${costVsControl.toFixed(0)}% cheaper than Control` 
            : costVsControl < 0 
              ? `${Math.abs(costVsControl).toFixed(0)}% more expensive than Control`
              : 'same as Control';
        
        const scoreVsControl = controlScore ? score.overallScore - controlScore.overallScore : 0;
        const scoreComparison = model.isControl
          ? '(BASELINE)'
          : scoreVsControl > 0
            ? `+${scoreVsControl.toFixed(1)} points vs Control`
            : scoreVsControl < 0
              ? `${scoreVsControl.toFixed(1)} points vs Control`
              : 'same as Control';
        
        // Calculate value score (quality per dollar)
        const valueScore = cost > 0 ? Math.round(score.overallScore / cost) : 0;
        
        return `
### ${model.name} (${model.provider})${model.isControl ? ' ⭐ CONTROL BASELINE' : ''}
- **Overall Score**: ${score.overallScore}/100 ${scoreComparison}
- **Value Score**: ${valueScore} points per dollar
- **Cost**: $${cost.toFixed(4)} ${costComparison}${summary?.statsEstimated ? ' (estimated)' : ''}
- **Time**: ${summary?.elapsedTimeMs ? (summary.elapsedTimeMs / 1000).toFixed(1) + 's' : 'N/A'}
- **Factual Accuracy**: ${score.factualAccuracy?.score || 0}/100 - ${score.factualAccuracy?.rationale || 'N/A'}
- **Citation Accuracy**: ${score.pageLineAccuracy?.score || 0}/100 - ${score.pageLineAccuracy?.rationale || 'N/A'}
- **Relevance**: ${score.relevance?.score || 0}/100 - ${score.relevance?.rationale || 'N/A'}
- **Comprehensiveness**: ${score.comprehensiveness?.score || 0}/100 - ${score.comprehensiveness?.rationale || 'N/A'}
- **Legal Utility**: ${score.legalUtility?.score || 0}/100 - ${score.legalUtility?.rationale || 'N/A'}
- **Strengths**: ${score.strengths?.join('; ') || 'None'}
- **Weaknesses**: ${score.weaknesses?.join('; ') || 'None'}
- **Errors**: ${score.specificErrors?.map(e => `[${e.type}/${e.severity}] ${e.explanation}`).join('; ') || 'None'}
- **Missing Items**: ${score.missingItems?.join('; ') || 'None'}
- **Recommendation**: ${score.recommendation || 'N/A'}
`;
      }).filter(Boolean).join('\n');
      
      // Model pricing info for context
      const modelPricing = selectedModels.map(m => 
        `- ${m.name}: $${m.inputPricePer1M}/M input, $${m.outputPricePer1M}/M output${m.isControl ? ' (CONTROL)' : ''}`
      ).join('\n');
      
      const systemPrompt = `You are an expert legal document analysis assistant (${JUDGE_MODEL.name}). You have just analyzed multiple AI-generated summaries of a legal document and provided quality scores.

Here is the context of the analysis:

**Document**: ${matter.name}
**Summary Type**: ${SUMMARY_TYPE_INFO[matter.summaryType]?.label || matter.summaryType}
**Source Document Length**: ~${matter.sourceDocuments[0]?.content?.length?.toLocaleString() || 'Unknown'} characters

## Control Baseline
The "Control" model (${controlModel?.name || 'N/A'}) represents our current production system. All cost and quality comparisons use this as the baseline.
- Control Cost: $${controlCost.toFixed(4)}
- Control Score: ${controlScore?.overallScore || 'N/A'}/100

## Model Pricing (per million tokens)
${modelPricing}

## Analysis Results by Model (sorted by score)
${resultsContext}

**IMPORTANT CONTEXT FOR COST QUESTIONS:**
- When a model shows "-98% cost", it means the model costs 98% LESS than the Control baseline
- Cost savings = ((Control Cost - Model Cost) / Control Cost) × 100%
- The Control is our current production system; we're evaluating if other models can do better for less money
- Value Score = Quality Points / Cost in dollars (higher is better)

The user can now ask you follow-up questions about these results. Be specific, cite the analysis findings, and help them understand:
1. Quality differences between models
2. Cost comparisons (always relative to the Control baseline)
3. Value propositions (quality per dollar)
4. Specific errors or issues found
5. Which model would be best for their use case`;

      // Build messages array with history
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...chatMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user' as const, content: userMessage },
      ];
      
      const result = await createChatCompletion(JUDGE_MODEL.id, messages);
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      const assistantMessage = result.data?.choices[0]?.message?.content || 'Sorry, I could not generate a response.';
      setChatMessages(prev => [...prev, { role: 'assistant', content: assistantMessage }]);
      
      // Scroll to bottom
      setTimeout(() => {
        chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 100);
      
    } catch (error) {
      toast({
        title: 'Chat Error',
        description: error instanceof Error ? error.message : 'Failed to send message',
        variant: 'destructive',
      });
      // Remove the user message on error
      setChatMessages(prev => prev.slice(0, -1));
    } finally {
      setChatLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!matter) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-medium mb-2">Matter not found</h2>
        <Link href="/">
          <Button variant="outline">Return to Dashboard</Button>
        </Link>
      </div>
    );
  }

  // Show processing UI if either local processing state is true OR matter.status indicates processing
  const isProcessing = processing || runningAnalysis || ['uploading', 'processing', 'summarizing', 'analyzing'].includes(
    matter.status
  );
  const isCompleted = matter.status === 'completed' && !processing && !runningAnalysis;

  // Calculate rankings from quality scores
  const rankedModels = Object.values(matter.qualityScores)
    .sort((a, b) => b.overallScore - a.overallScore)
    .map((score, index) => {
      const testModel = TEST_MODELS.find((m) => m.id === score.model);
      const summary = matter.summaries[score.model];
      
      return {
        ...score,
        rank: index + 1,
        model: testModel,
        summary: summary,
        displayName: testModel?.name || score.model,
      };
    });

  const bestOverall = rankedModels[0];
  // Best Value: Use valueScore (quality + cost savings) or fall back to costEffectiveness
  const bestValue = [...rankedModels].sort(
    (a, b) => (b.valueScore || b.costEffectiveness) - (a.valueScore || a.costEffectiveness)
  )[0];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-gradient-to-r from-card to-card/80">
        <div className="px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-serif font-semibold tracking-tight">
                    {matter.name}
                  </h1>
                  <Badge variant="outline" className="capitalize">
                    {matter.summaryType}
                  </Badge>
                </div>
              </div>
            </div>
            {isCompleted && (
              <Button variant="outline" className="gap-2" onClick={downloadAllSummaries}>
                <Download className="h-4 w-4" />
                Download All
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {/* Processing View */}
        {isProcessing && (
          <div className="max-w-3xl mx-auto space-y-4">
            {/* Live Stats Banner */}
            {(totalTokensUsed > 0 || totalCostSoFar > 0 || currentModelId || analysisModelId) && (
              <div className="grid grid-cols-4 gap-4">
                <div className="p-3 rounded-lg bg-card border border-border text-center">
                  <p className="text-xs text-muted-foreground">Tokens Used</p>
                  <p className="text-lg font-mono font-semibold text-blue-400">
                    {totalTokensUsed.toLocaleString()}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-card border border-border text-center">
                  <p className="text-xs text-muted-foreground">Cost So Far</p>
                  <p className="text-lg font-mono font-semibold text-green-400">
                    ${totalCostSoFar.toFixed(4)}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-card border border-border text-center">
                  <p className="text-xs text-muted-foreground">Completed</p>
                  <p className="text-lg font-mono font-semibold text-emerald-400">
                    {Object.values(matter.summaries).filter(s => s.status === 'completed').length} / {TEST_MODELS.length}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-card border border-border text-center">
                  <p className="text-xs text-muted-foreground">Current Task</p>
                  <p className="text-sm font-medium truncate">
                    {currentModelId && elapsedSeconds > 0 && (
                      <span className="text-primary">{elapsedSeconds}s</span>
                    )}
                    {!currentModelId && analysisModelId && elapsedSeconds > 0 && (
                      <span className="text-amber-400">{elapsedSeconds}s</span>
                    )}
                    {!currentModelId && !analysisModelId && '—'}
                  </p>
                </div>
              </div>
            )}

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="font-serif flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-primary animate-pulse" />
                      Processing
                    </CardTitle>
                    <CardDescription>
                      {currentPhase === 'process' 
                        ? 'Extracting text from documents...'
                        : currentPhase === 'summarize'
                        ? `Generating summaries across ${matter.modelsToTest?.length || TEST_MODELS.length} models...`
                        : currentPhase === 'analyze'
                        ? 'Analyzing quality with GPT-5.2...'
                        : `Processing ${matter.modelsToTest?.length || TEST_MODELS.length} models`
                      }
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      className="gap-2 text-xs"
                      onClick={cancelProcessing}
                      disabled={isCancelling}
                    >
                      {isCancelling ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Cancelling...
                        </>
                      ) : (
                        <>
                          <XCircle className="h-3 w-3" />
                          Cancel
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                
                {/* Current Activity Banner */}
                {currentActivity && (
                  <div className="mt-3 flex items-center gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
                    <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                    <p className="text-sm text-primary truncate">{currentActivity}</p>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Show default steps if not yet initialized */}
                {(steps.length > 0 ? steps : [
                  { id: 'process', label: 'Process Documents', status: 'pending' as const },
                  { id: 'summarize', label: 'Generate Summaries', status: 'pending' as const },
                  { id: 'analyze', label: 'Quality Analysis', status: 'pending' as const },
                ]).map((step, index) => (
                  <div key={step.id} className="space-y-2">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center shrink-0',
                          step.status === 'completed'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : step.status === 'running'
                            ? 'bg-primary/20 text-primary'
                            : step.status === 'error'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {step.status === 'completed' ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : step.status === 'running' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : step.status === 'error' ? (
                          <AlertCircle className="h-4 w-4" />
                        ) : (
                          <span className="text-xs font-medium">{index + 1}</span>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{step.label}</span>
                          {step.status === 'running' && step.progress !== undefined && (
                            <span className="text-sm text-muted-foreground">
                              {step.progress}%
                            </span>
                          )}
                          {step.status === 'running' && currentPhase === 'process' && elapsedSeconds > 0 && (
                            <span className="text-sm font-mono text-primary">
                              {elapsedSeconds}s
                            </span>
                          )}
                        </div>
                        {step.detail && (
                          <p className="text-sm text-muted-foreground">{step.detail}</p>
                        )}
                      </div>
                    </div>
                    {step.status === 'running' && (
                      <Progress value={step.progress} className="h-1 ml-11" />
                    )}
                  </div>
                ))}
                
                {/* Activity Log - Always visible during processing */}
                <div className="mt-4 pt-4 border-t border-border">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <Terminal className="h-3 w-3" />
                      Live Activity Log ({processingLog.length} entries)
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => setShowProcessingLog(!showProcessingLog)}
                      >
                        {showProcessingLog ? 'Collapse' : 'Expand'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => setProcessingLog([])}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  {showProcessingLog && (
                    <ScrollArea className="h-[350px] w-full rounded border border-border bg-background/50">
                      <div className="p-2 space-y-1 font-mono text-xs">
                        {processingLog.length === 0 ? (
                          <p className="text-muted-foreground text-center py-4">Waiting for activity...</p>
                        ) : processingLog.map((entry, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              "flex gap-2 py-1 px-2 rounded group",
                              entry.type === 'success' && "bg-emerald-500/5 text-emerald-400",
                              entry.type === 'error' && "bg-red-500/5 text-red-400",
                              entry.type === 'warning' && "bg-amber-500/5 text-amber-400",
                              entry.type === 'info' && "text-muted-foreground"
                            )}
                          >
                            <span className="text-muted-foreground shrink-0">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                            <span className="shrink-0">
                              {entry.type === 'success' && '✓'}
                              {entry.type === 'error' && '✗'}
                              {entry.type === 'warning' && '⚠'}
                              {entry.type === 'info' && '→'}
                            </span>
                            <span className="flex-1">{entry.message}</span>
                            {entry.detail && (
                              <span className="text-muted-foreground truncate max-w-[200px]">
                                {entry.detail}
                              </span>
                            )}
                            {entry.type === 'error' && (
                              <button
                                onClick={() => {
                                  const text = `${entry.message}${entry.detail ? ` - ${entry.detail}` : ''}`;
                                  navigator.clipboard.writeText(text);
                                  toast({ title: 'Copied!', description: 'Error message copied to clipboard' });
                                }}
                                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-500/20 rounded"
                                title="Copy error"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Document Processing Details */}
            {currentPhase === 'process' && docProcessingStatus.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileStack className="h-4 w-4" />
                    Document Processing
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {docProcessingStatus.map((doc) => (
                      <div
                        key={doc.type}
                        className={cn(
                          "p-4 rounded-lg border transition-all",
                          doc.status === 'completed' && "border-emerald-500/30 bg-emerald-500/5",
                          doc.status === 'error' && "border-red-500/30 bg-red-500/5",
                          (doc.status === 'uploading' || doc.status === 'processing' || doc.status === 'extracting') && "border-primary/30 bg-primary/5"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          {/* Status Icon */}
                          <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                            doc.status === 'completed' && "bg-emerald-500/20 text-emerald-400",
                            doc.status === 'error' && "bg-red-500/20 text-red-400",
                            doc.status === 'pending' && "bg-muted text-muted-foreground",
                            (doc.status === 'uploading' || doc.status === 'processing' || doc.status === 'extracting') && "bg-primary/20 text-primary"
                          )}>
                            {doc.status === 'completed' ? (
                              <CheckCircle2 className="h-4 w-4" />
                            ) : doc.status === 'error' ? (
                              <AlertCircle className="h-4 w-4" />
                            ) : doc.status === 'pending' ? (
                              <FileText className="h-4 w-4" />
                            ) : (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                          </div>
                          
                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <p className="font-medium truncate">{doc.filename}</p>
                              <Badge 
                                variant="outline" 
                                className={cn(
                                  "text-xs shrink-0",
                                  doc.type === 'source' && "border-primary/30 text-primary",
                                  doc.type === 'control' && "border-amber-500/30 text-amber-400"
                                )}
                              >
                                {doc.type === 'source' ? 'Source' : 'Control'}
                              </Badge>
                            </div>
                            
                            {/* Status detail */}
                            <p className="text-sm text-muted-foreground">
                              {doc.status === 'uploading' && (
                                <span className="flex items-center gap-2">
                                  <Upload className="h-3 w-3" />
                                  {doc.detail || 'Uploading...'}
                                </span>
                              )}
                              {doc.status === 'processing' && (
                                <span className="flex items-center gap-2">
                                  <Cpu className="h-3 w-3" />
                                  {doc.detail || 'Processing...'}
                                </span>
                              )}
                              {doc.status === 'extracting' && (
                                <span className="flex items-center gap-2">
                                  <FileText className="h-3 w-3" />
                                  {doc.detail || 'Extracting text...'}
                                </span>
                              )}
                              {doc.status === 'completed' && (
                                <span className="flex items-center gap-2 text-emerald-400">
                                  <CheckCircle2 className="h-3 w-3" />
                                  {doc.pageCount && `${doc.pageCount} pages • `}
                                  {doc.charCount?.toLocaleString()} characters extracted
                                </span>
                              )}
                              {doc.status === 'error' && (
                                <span className="flex items-center gap-2 text-red-400">
                                  <AlertCircle className="h-3 w-3" />
                                  {doc.detail || 'Processing failed'}
                                </span>
                              )}
                              {doc.status === 'pending' && (
                                <span>Waiting...</span>
                              )}
                            </p>
                            
                            {/* File size */}
                            {doc.size && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {(doc.size / 1024).toFixed(0)} KB
                              </p>
                            )}
                          </div>
                          
                          {/* Timer for active processing */}
                          {(doc.status === 'uploading' || doc.status === 'processing' || doc.status === 'extracting') && 
                            doc.startTime && (
                            <span className="text-sm font-mono text-primary shrink-0">
                              {Math.floor((Date.now() - doc.startTime) / 1000)}s
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Expanded Summary Generation Status - Always show during processing */}
            {(isProcessing || 
              steps.find(s => s.id === 'summarize')?.status === 'running' || 
              steps.find(s => s.id === 'summarize')?.status === 'completed' ||
              Object.keys(matter.summaries).length > 0) && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Summary Generation
                    </CardTitle>
                    <div className="flex items-center gap-4">
                      {/* Running totals */}
                      {(totalTokensUsed > 0 || totalCostSoFar > 0) && (
                        <div className="flex items-center gap-4 text-xs">
                          {totalTokensUsed > 0 && (
                            <span className="text-muted-foreground">
                              <span className="font-mono text-blue-400">{totalTokensUsed.toLocaleString()}</span> tokens
                            </span>
                          )}
                          {totalCostSoFar > 0 && (
                            <span className="text-muted-foreground">
                              <span className="font-mono text-green-400">${totalCostSoFar.toFixed(4)}</span> spent
                            </span>
                          )}
                        </div>
                      )}
                      {/* Refresh All Button */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={refreshAllJobs}
                        disabled={refreshingAll}
                        className="gap-2 text-xs h-7"
                      >
                        <RefreshCw className={cn("h-3 w-3", refreshingAll && "animate-spin")} />
                        {refreshingAll && refreshProgress 
                          ? `${refreshProgress.current}/${refreshProgress.total}: ${refreshProgress.modelName}`
                          : 'Refresh All'}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {/* Only show models that were selected for this comparison */}
                    {(matter.modelsToTest 
                      ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
                      : TEST_MODELS
                    ).map((model) => {
                      const summary = matter.summaries[model.id];
                      const isCurrentlyGenerating = currentModelId === model.id;
                      const isExpanded = expandedSummaryId === model.id;
                      
                      return (
                        <div key={model.id} className="space-y-0">
                          <div
                            className={cn(
                              "flex items-center gap-3 p-3 rounded-lg transition-all duration-300",
                              summary?.status === 'completed' && "bg-emerald-500/5 cursor-pointer hover:bg-emerald-500/10",
                              summary?.status === 'completed_no_download' && "bg-amber-500/5 border border-amber-500/30",
                              summary?.status === 'error' && "bg-red-500/5",
                              isCurrentlyGenerating && "bg-primary/5 ring-1 ring-primary/20",
                              justCompletedModelId === model.id && "ring-2 ring-emerald-400 bg-emerald-500/10",
                              isExpanded && "rounded-b-none border-b border-border"
                            )}
                            onClick={() => {
                              if (summary?.status === 'completed') {
                                setExpandedSummaryId(isExpanded ? null : model.id);
                              }
                            }}
                          >
                            <div
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: model.color }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium">{model.name}</p>
                              {/* Show additional details when completed */}
                              {summary?.status === 'completed' && (
                                <p className="text-xs text-muted-foreground">
                                  {summary.statsEstimated && <span className="text-amber-400" title="Stats estimated - API didn't return actual usage">~</span>}
                                  {summary.inputTokens.toLocaleString()} in / {summary.outputTokens.toLocaleString()} out • {summary.content.length.toLocaleString()} chars
                                  {summary.statsEstimated && <span className="text-amber-400 ml-1" title="Cost and token counts are estimated">(est)</span>}
                                  {!isExpanded && <span className="ml-2 text-primary">Click to preview →</span>}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {isCurrentlyGenerating && !summary ? (
                                <div className="flex items-center gap-3">
                                  <span className="text-xs font-mono text-primary">
                                    {elapsedSeconds}s
                                  </span>
                                  <Badge variant="outline" className="gap-1 text-xs animate-pulse">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    Generating...
                                  </Badge>
                                </div>
                              ) : summary?.status === 'completed' ? (
                                <div className="flex items-center gap-2">
                                  <span 
                                    className={cn("text-xs font-mono", summary.statsEstimated ? "text-amber-400" : "text-green-400")}
                                    title={summary.statsEstimated ? "Estimated cost - API didn't return actual usage" : "Actual cost from CaseMark API"}
                                  >
                                    {summary.statsEstimated && '~'}${summary.costUsd.toFixed(4)}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {formatDuration(summary.elapsedTimeMs)}
                                  </span>
                                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                                  <ChevronDown className={cn(
                                    "h-4 w-4 text-muted-foreground transition-transform",
                                    isExpanded && "rotate-180"
                                  )} />
                                </div>
                              ) : summary?.status === 'completed_no_download' ? (
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                                    <CheckCircle2 className="h-3 w-3 mr-1" />
                                    CaseMark Done
                                  </Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      downloadSummaryContent(model.id);
                                    }}
                                    disabled={retryingModels.has(model.id)}
                                    className="h-6 text-xs gap-1 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                                  >
                                    {retryingModels.has(model.id) ? (
                                      <>
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Extracting...
                                      </>
                                    ) : (
                                      <>
                                        <Download className="h-3 w-3" />
                                        Download
                                      </>
                                    )}
                                  </Button>
                                </div>
                              ) : summary?.status === 'error' ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-red-400 max-w-[120px] truncate" title={summary.error}>
                                    {summary.error}
                                  </span>
                                  {summary.casemarkWorkflowId && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        checkWorkflowStatus(model.id);
                                      }}
                                      disabled={retryingModels.has(model.id)}
                                      className="h-6 text-xs gap-1 text-blue-400 border-blue-500/30 hover:bg-blue-500/10"
                                    >
                                      {retryingModels.has(model.id) ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-3 w-3" />
                                      )}
                                      Check Status
                                    </Button>
                                  )}
                                  <AlertCircle className="h-4 w-4 text-red-400" />
                                </div>
                              ) : summary?.status === 'generating' ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-blue-400">
                                    CaseMark processing...
                                  </span>
                                  {summary.casemarkWorkflowId && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        checkWorkflowStatus(model.id);
                                      }}
                                      disabled={retryingModels.has(model.id)}
                                      className="h-6 text-xs gap-1 text-blue-400 border-blue-500/30 hover:bg-blue-500/10"
                                    >
                                      {retryingModels.has(model.id) ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-3 w-3" />
                                      )}
                                      Check
                                    </Button>
                                  )}
                                  <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">Pending</span>
                              )}
                            </div>
                          </div>
                          
                          {/* Expanded Preview */}
                          {isExpanded && summary?.status === 'completed' && (
                            <div className="bg-muted/50 rounded-b-lg border border-t-0 border-border p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                  Summary Preview <span className="text-muted-foreground/50 normal-case">(extracted text)</span>
                                </p>
                                <div className="flex items-center gap-2">
                                  {summary.casemarkWorkflowId && (
                                    <Button
                                      variant="default"
                                      size="sm"
                                      className="h-7 text-xs gap-1 bg-blue-600 hover:bg-blue-700"
                                      disabled={downloadingPdf === model.id}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        viewPdf(model.id);
                                      }}
                                    >
                                      {downloadingPdf === model.id ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <ExternalLink className="h-3 w-3" />
                                      )}
                                      View PDF
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs gap-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(summary.content);
                                      toast({ title: 'Copied to clipboard' });
                                    }}
                                  >
                                    <Copy className="h-3 w-3" />
                                    Copy
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs gap-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      downloadSummary(model.id);
                                    }}
                                  >
                                    <Download className="h-3 w-3" />
                                    Text
                                  </Button>
                                </div>
                              </div>
                              <ScrollArea className="h-[300px] w-full rounded border border-border bg-background p-3">
                                <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed">
                                  {summary.content}
                                </pre>
                              </ScrollArea>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Expanded Quality Analysis Status - Always show during processing */}
            {(isProcessing ||
              steps.find(s => s.id === 'analyze')?.status === 'running' || 
              steps.find(s => s.id === 'analyze')?.status === 'completed' ||
              Object.keys(matter.qualityScores).length > 0) && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="h-4 w-4" />
                      Quality Analysis (GPT-5.2)
                    </CardTitle>
                    {currentPhase === 'analyze' && (
                      <span className="text-xs text-muted-foreground">
                        Judging summaries against source & control...
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {/* Only show models that were selected for this comparison */}
                    {(matter.modelsToTest 
                      ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
                      : TEST_MODELS
                    ).map((model) => {
                      const summary = matter.summaries[model.id];
                      const score = matter.qualityScores[model.id];
                      // Check BOTH state variables for reliability
                      const isCurrentlyAnalyzing = analysisModelId === model.id || analyzingModels.has(model.id);
                      
                      // Skip if summary not ready (completed or completed_no_download means ready for analysis)
                      const summaryReady = summary?.status === 'completed' || summary?.status === 'completed_no_download';
                      if (!summary || !summaryReady) {
                        return (
                          <div
                            key={model.id}
                            className="flex items-center gap-3 p-3 rounded-lg opacity-50"
                          >
                            <div
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: model.color }}
                            />
                            <div className="flex-1">
                              <p className="text-sm font-medium">{model.name}</p>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {summary?.status === 'error' ? 'Summary failed' : 
                               summary?.status === 'generating' ? 'Generating...' : 'Awaiting summary'}
                            </span>
                          </div>
                        );
                      }
                      
                      return (
                        <div
                          key={model.id}
                          className={cn(
                            "flex items-center gap-3 p-3 rounded-lg transition-all duration-300",
                            score && "bg-emerald-500/5",
                            isCurrentlyAnalyzing && "bg-primary/5 ring-1 ring-primary/20",
                            justAnalyzedModelId === model.id && "ring-2 ring-amber-400 bg-amber-500/10"
                          )}
                        >
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: model.color }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">{model.name}</p>
                            {/* Show score breakdown when complete */}
                            {score && (
                              <p className="text-xs text-muted-foreground">
                                Factual: {score.factualAccuracy.score} • Citations: {score.pageLineAccuracy.score} • Relevance: {score.relevance.score}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {extractingModels.has(model.id) ? (
                              <Badge variant="outline" className="gap-1 text-xs text-amber-400 border-amber-500/30 animate-pulse">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Extracting text...
                              </Badge>
                            ) : isCurrentlyAnalyzing && !score ? (
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-mono text-primary">
                                  {elapsedSeconds}s
                                </span>
                                <Badge variant="outline" className="gap-1 text-xs text-blue-400 border-blue-500/30 animate-pulse">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Analyzing with GPT-5.2...
                                </Badge>
                              </div>
                            ) : score ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono text-green-400">
                                  ${score.costUsd?.toFixed(4) || '0.00'}
                                </span>
                                <span className={cn(
                                  "text-sm font-bold",
                                  getScoreColor(score.overallScore)
                                )}>
                                  {Math.round(score.overallScore)}/100
                                </span>
                                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                              </div>
                            ) : runningAnalysis ? (
                              <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                                <Clock className="h-3 w-3" />
                                Queued
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">Pending</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Results View */}
        {isCompleted && rankedModels.length > 0 && (
          <div className="space-y-8">
            {/* Control Summary Banner */}
            {matter.controlSummary && (
              <Card className="border-amber-500/30 bg-gradient-to-r from-amber-500/5 via-transparent to-amber-500/5">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="p-2 rounded-lg bg-amber-500/10">
                        <Shield className="h-5 w-5 text-amber-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-amber-400">Production Control</p>
                          <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400">
                            Baseline
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {matter.controlSummary.source === 'uploaded' 
                            ? `Uploaded: ${matter.controlSummary.filename || 'Control summary'}` 
                            : 'Production CaseMark output'}
                          {matter.controlSummary.notes && ` • ${matter.controlSummary.notes}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-muted-foreground">
                        {matter.controlSummary.content.length.toLocaleString()} chars
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const blob = new Blob([matter.controlSummary!.content], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `control-summary-${matter.name.replace(/\s+/g, '-')}.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        className="gap-1"
                      >
                        <Download className="h-3 w-3" />
                        Download
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Winner Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Best Overall */}
              <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-emerald-500/10">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Trophy className="h-5 w-5 text-emerald-400" />
                    <CardTitle className="text-emerald-400">Best Overall</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-2xl font-bold">{bestOverall?.model?.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {bestOverall?.model?.provider}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-3xl font-bold text-emerald-400">
                        {Math.round(bestOverall?.overallScore || 0)}
                      </p>
                      <p className="text-sm text-muted-foreground">score</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Best Value */}
              <Card className="border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-amber-500/10">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Zap className="h-5 w-5 text-amber-400" />
                    <CardTitle className="text-amber-400">Best Value</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-2xl font-bold">{bestValue?.model?.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {bestValue?.model?.provider}
                        {bestValue?.costSavingsPercent !== undefined && bestValue.costSavingsPercent > 0 && (
                          <span className="ml-2 text-emerald-400">
                            ({bestValue.costSavingsPercent}% cheaper)
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-3xl font-bold text-amber-400">
                        {bestValue?.valueScore || Math.round(bestValue?.costEffectiveness || 0)}
                      </p>
                      <p className="text-sm text-muted-foreground">value score</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Detailed Results */}
            <Tabs defaultValue="rankings" className="space-y-6">
              <div className="flex items-center justify-between">
                <TabsList>
                  <TabsTrigger value="rankings" className="gap-2">
                    <BarChart3 className="h-4 w-4" />
                    Rankings
                  </TabsTrigger>
                  <TabsTrigger value="costs" className="gap-2">
                    <DollarSign className="h-4 w-4" />
                    Cost Analysis
                  </TabsTrigger>
                  <TabsTrigger value="details" className="gap-2">
                    <Target className="h-4 w-4" />
                    Detailed Scores
                  </TabsTrigger>
                  <TabsTrigger value="errors" className="gap-2">
                    <AlertCircle className="h-4 w-4" />
                    Errors
                    {rankedModels.reduce((acc, m) => acc + (m.specificErrors?.length || 0), 0) > 0 && (
                      <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-xs">
                        {rankedModels.reduce((acc, m) => acc + (m.specificErrors?.length || 0), 0)}
                      </Badge>
                    )}
                  </TabsTrigger>
                  {matter.controlSummary && (
                    <TabsTrigger value="control" className="gap-2">
                      <Shield className="h-4 w-4" />
                      Control
                      <Badge variant="outline" className="ml-1 h-5 px-1.5 text-xs border-amber-500/30 text-amber-400">
                        PROD
                      </Badge>
                    </TabsTrigger>
                  )}
                </TabsList>
                
                {/* Chat with Judge Button */}
                <Button
                  variant={showChat ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    const newState = !showChat;
                    setShowChat(newState);
                    // Scroll chat panel into view when opening
                    if (newState) {
                      setTimeout(() => {
                        document.getElementById('chat-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 100);
                    }
                  }}
                  className="gap-2"
                >
                  <MessageSquare className="h-4 w-4" />
                  {showChat ? 'Hide Chat' : 'Ask Judge'}
                </Button>
              </div>

              {/* Rankings Tab - Full Score Display */}
              <TabsContent value="rankings">
                <div className="space-y-6">
                  {rankedModels.map((item) => (
                    <Card 
                      key={item.model?.id}
                      className={cn(
                        'overflow-hidden transition-all',
                        item.rank === 1 && 'ring-2 ring-emerald-500/30 bg-emerald-500/5'
                      )}
                    >
                      {/* Header Row */}
                      <div className="p-4 border-b border-border/50">
                        <div className="flex items-center gap-4">
                          <div
                            className={cn(
                              'w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg shrink-0',
                              item.rank === 1
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : item.rank === 2
                                ? 'bg-slate-500/20 text-slate-400'
                                : item.rank === 3
                                ? 'bg-amber-700/20 text-amber-600'
                                : 'bg-muted text-muted-foreground'
                            )}
                          >
                            #{item.rank}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <div
                                className="w-3 h-3 rounded-full shrink-0"
                                style={{ backgroundColor: item.model?.color }}
                              />
                              <p className="font-semibold text-lg">{item.model?.name}</p>
                              {item.rank === 1 && (
                                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                                  <Trophy className="h-3 w-3 mr-1" />
                                  Best
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">{item.model?.provider}</p>
                          </div>
                          <div className="flex items-center gap-6 shrink-0">
                            {/* Standalone Score */}
                            <div className="text-center">
                              <p className={cn('text-3xl font-bold', getScoreColor(item.overallScore))}>
                                {Math.round(item.overallScore)}
                              </p>
                              <p className="text-xs text-muted-foreground">Quality</p>
                            </div>
                            
                            {/* vs Control Score - only show for non-control models */}
                            {item.model?.id !== 'casemark/default' && item.vsControlScore !== undefined && (
                              <div className="text-center border-l border-border/50 pl-6">
                                <p className={cn(
                                  'text-2xl font-bold',
                                  item.vsControlScore > 0 ? 'text-emerald-400' :
                                  item.vsControlScore < 0 ? 'text-red-400' : 'text-muted-foreground'
                                )}>
                                  {item.vsControlScore > 0 ? '+' : ''}{item.vsControlScore}
                                </p>
                                <p className="text-xs text-muted-foreground">vs Control</p>
                              </div>
                            )}
                            
                            {/* Cost Savings */}
                            {item.model?.id !== 'casemark/default' && item.costSavingsPercent !== undefined && (
                              <div className="text-center">
                                <p className={cn(
                                  'text-xl font-bold',
                                  item.costSavingsPercent > 50 ? 'text-emerald-400' :
                                  item.costSavingsPercent > 0 ? 'text-teal-400' :
                                  item.costSavingsPercent < 0 ? 'text-red-400' : 'text-muted-foreground'
                                )}>
                                  {item.costSavingsPercent > 0 ? '-' : '+'}{Math.abs(item.costSavingsPercent)}%
                                </p>
                                <p className="text-xs text-muted-foreground">Cost</p>
                              </div>
                            )}
                            
                            {/* Value Score */}
                            {item.valueScore !== undefined && (
                              <div className="text-center border-l border-border/50 pl-6">
                                <p className={cn(
                                  'text-2xl font-bold',
                                  item.valueScore >= 90 ? 'text-amber-400' :
                                  item.valueScore >= 70 ? 'text-teal-400' : 'text-muted-foreground'
                                )}>
                                  {item.valueScore}
                                </p>
                                <p className="text-xs text-muted-foreground">Value</p>
                              </div>
                            )}
                            
                            {/* Control Badge */}
                            {item.model?.id === 'casemark/default' && (
                              <Badge variant="outline" className="border-amber-500/50 text-amber-400 ml-2">
                                ⭐ CONTROL
                              </Badge>
                            )}
                            
                            <div className="text-center border-l border-border/50 pl-6">
                              <p className="text-lg font-medium">{formatCurrency(item.summary?.costUsd || 0)}</p>
                              <p className="text-xs text-muted-foreground">Actual</p>
                            </div>
                            <div className="text-center">
                              <p className="text-lg font-medium">{formatDuration(item.summary?.elapsedTimeMs || 0)}</p>
                              <p className="text-xs text-muted-foreground">Time</p>
                            </div>
                            {item.summary?.casemarkWorkflowId && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => viewPdf(item.model?.id || '')}
                                disabled={downloadingPdf === item.model?.id}
                                className="gap-2"
                              >
                                {downloadingPdf === item.model?.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <FileText className="h-4 w-4" />
                                )}
                                View PDF
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Score Breakdown - Full Width with Complete Rationales */}
                      <div className="p-6 bg-muted/20 space-y-4">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                          Category Scores
                        </p>
                        {[
                          { label: 'Factual Accuracy', score: item.factualAccuracy, weight: '25%', desc: 'Correctness of facts vs source document' },
                          { label: 'Citation Accuracy', score: item.pageLineAccuracy, weight: '20%', desc: 'Page/line reference precision' },
                          { label: 'Relevance', score: item.relevance, weight: '20%', desc: 'Legal significance of included content' },
                          { label: 'Comprehensiveness', score: item.comprehensiveness, weight: '15%', desc: 'Coverage of key testimony points' },
                          { label: 'Legal Utility', score: item.legalUtility, weight: '20%', desc: 'Usefulness for legal practice' },
                        ].map((cat) => (
                          <div key={cat.label} className="space-y-2">
                            <div className="flex items-center gap-4">
                              <div className="w-40 shrink-0">
                                <span className="text-sm font-medium">{cat.label}</span>
                                <span className="text-xs text-muted-foreground ml-2">({cat.weight})</span>
                              </div>
                              <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    'h-full rounded-full transition-all',
                                    (cat.score?.score || 0) >= 80 ? 'bg-emerald-500' :
                                    (cat.score?.score || 0) >= 60 ? 'bg-teal-500' :
                                    (cat.score?.score || 0) >= 40 ? 'bg-amber-500' : 'bg-red-500'
                                  )}
                                  style={{ width: `${cat.score?.score || 0}%` }}
                                />
                              </div>
                              <span className={cn('text-lg font-bold w-12 text-right', getScoreColor(cat.score?.score || 0))}>
                                {Math.round(cat.score?.score || 0)}
                              </span>
                            </div>
                            {/* Full Rationale - No truncation */}
                            {cat.score?.rationale && (
                              <p className="text-sm text-muted-foreground pl-44 leading-relaxed">
                                {cat.score.rationale}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Strengths - Full List */}
                      <div className="p-6 border-t border-border/30">
                        <div className="flex items-center gap-2 mb-4">
                          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                          <span className="text-sm font-semibold text-emerald-400 uppercase tracking-wide">
                            Strengths ({item.strengths?.length || 0})
                          </span>
                        </div>
                        {item.strengths && item.strengths.length > 0 ? (
                          <ul className="text-sm text-muted-foreground space-y-2">
                            {item.strengths.map((s, i) => (
                              <li key={i} className="flex gap-2">
                                <span className="text-emerald-400 shrink-0">•</span>
                                <span>{s}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground/50 italic">None identified</p>
                        )}
                      </div>

                      {/* Weaknesses - Full List */}
                      <div className="p-6 border-t border-border/30">
                        <div className="flex items-center gap-2 mb-4">
                          <AlertCircle className="h-5 w-5 text-amber-400" />
                          <span className="text-sm font-semibold text-amber-400 uppercase tracking-wide">
                            Weaknesses ({item.weaknesses?.length || 0})
                          </span>
                        </div>
                        {item.weaknesses && item.weaknesses.length > 0 ? (
                          <ul className="text-sm text-muted-foreground space-y-2">
                            {item.weaknesses.map((w, i) => (
                              <li key={i} className="flex gap-2">
                                <span className="text-amber-400 shrink-0">•</span>
                                <span>{w}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground/50 italic">None identified</p>
                        )}
                      </div>

                      {/* Control Comparison - KEY ANALYSIS SECTION */}
                      {item.model?.id !== 'casemark/default' && typeof item.controlComparison === 'object' && item.controlComparison && (
                        <div className="p-6 border-t border-border/30 bg-gradient-to-r from-amber-500/5 to-transparent">
                          <div className="flex items-center gap-2 mb-4">
                            <Shield className="h-5 w-5 text-amber-400" />
                            <span className="text-sm font-semibold text-amber-400 uppercase tracking-wide">
                              vs Control (Production) Analysis
                            </span>
                            {item.vsControlScore !== undefined && (
                              <Badge 
                                variant="outline" 
                                className={cn(
                                  'ml-2',
                                  item.vsControlScore > 0 ? 'border-emerald-500/50 text-emerald-400' :
                                  item.vsControlScore < 0 ? 'border-red-500/50 text-red-400' :
                                  'border-muted text-muted-foreground'
                                )}
                              >
                                {item.vsControlScore > 0 ? '+' : ''}{item.vsControlScore} points
                              </Badge>
                            )}
                          </div>
                          
                          {/* Summary */}
                          {item.controlComparison.summary && (
                            <p className="text-sm text-foreground mb-4 p-3 rounded-lg bg-card/50 border border-amber-500/20">
                              {item.controlComparison.summary}
                            </p>
                          )}
                          
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Areas where TEST is BETTER */}
                            <div className="p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                              <p className="text-xs font-semibold text-emerald-400 uppercase mb-2 flex items-center gap-2">
                                <CheckCircle className="h-4 w-4" />
                                Better Than Control ({item.controlComparison.testBetterThanControl?.length || 0})
                              </p>
                              {item.controlComparison.testBetterThanControl && item.controlComparison.testBetterThanControl.length > 0 ? (
                                <ul className="text-sm text-muted-foreground space-y-1.5">
                                  {item.controlComparison.testBetterThanControl.map((point, i) => (
                                    <li key={i} className="flex gap-2">
                                      <span className="text-emerald-400 shrink-0">↑</span>
                                      <span>{point}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-sm text-muted-foreground/50 italic">Similar to control</p>
                              )}
                            </div>
                            
                            {/* Areas where TEST is WORSE */}
                            <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20">
                              <p className="text-xs font-semibold text-red-400 uppercase mb-2 flex items-center gap-2">
                                <XCircle className="h-4 w-4" />
                                Worse Than Control ({item.controlComparison.testWorseThanControl?.length || 0})
                              </p>
                              {item.controlComparison.testWorseThanControl && item.controlComparison.testWorseThanControl.length > 0 ? (
                                <ul className="text-sm text-muted-foreground space-y-1.5">
                                  {item.controlComparison.testWorseThanControl.map((point, i) => (
                                    <li key={i} className="flex gap-2">
                                      <span className="text-red-400 shrink-0">↓</span>
                                      <span>{point}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-sm text-muted-foreground/50 italic">No disadvantages found</p>
                              )}
                            </div>
                            
                            {/* Items TEST found that CONTROL missed */}
                            {item.controlComparison.testIncludesControlMissing && item.controlComparison.testIncludesControlMissing.length > 0 && (
                              <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-500/20">
                                <p className="text-xs font-semibold text-blue-400 uppercase mb-2 flex items-center gap-2">
                                  <Plus className="h-4 w-4" />
                                  Found (Control Missed)
                                </p>
                                <ul className="text-sm text-muted-foreground space-y-1.5">
                                  {item.controlComparison.testIncludesControlMissing.map((point, i) => (
                                    <li key={i} className="flex gap-2">
                                      <span className="text-blue-400 shrink-0">+</span>
                                      <span>{point}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            
                            {/* Items CONTROL has that TEST missed */}
                            {item.controlComparison.controlIncludesTestMissing && item.controlComparison.controlIncludesTestMissing.length > 0 && (
                              <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                                <p className="text-xs font-semibold text-amber-400 uppercase mb-2 flex items-center gap-2">
                                  <Minus className="h-4 w-4" />
                                  Missed (Control Has)
                                </p>
                                <ul className="text-sm text-muted-foreground space-y-1.5">
                                  {item.controlComparison.controlIncludesTestMissing.map((point, i) => (
                                    <li key={i} className="flex gap-2">
                                      <span className="text-amber-400 shrink-0">-</span>
                                      <span>{point}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                          
                          {/* Cost-Benefit Summary */}
                          {item.costSavingsPercent !== undefined && (
                            <div className="mt-4 p-3 rounded-lg bg-card/50 border border-border/50">
                              <p className="text-sm">
                                <span className="text-muted-foreground">Cost Analysis: </span>
                                {item.costSavingsPercent > 0 ? (
                                  <span className="text-emerald-400 font-medium">
                                    {item.costSavingsPercent}% cheaper than control
                                    {item.vsControlScore !== undefined && item.vsControlScore >= 0 && (
                                      <span className="text-muted-foreground"> with {item.vsControlScore >= 0 ? 'equal or better' : 'lower'} quality</span>
                                    )}
                                  </span>
                                ) : item.costSavingsPercent < 0 ? (
                                  <span className="text-amber-400 font-medium">
                                    {Math.abs(item.costSavingsPercent)}% more expensive than control
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground font-medium">Same cost as control</span>
                                )}
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Errors - Full List with Details */}
                      <div className="p-6 border-t border-border/30">
                        <div className="flex items-center gap-2 mb-4">
                          <XCircle className="h-5 w-5 text-red-400" />
                          <span className="text-sm font-semibold text-red-400 uppercase tracking-wide">
                            Errors ({item.specificErrors?.length || 0})
                          </span>
                        </div>
                        {item.specificErrors && item.specificErrors.length > 0 ? (
                          <div className="space-y-4">
                            {item.specificErrors.map((e, i) => (
                              <div key={i} className="p-4 rounded-lg bg-red-500/5 border border-red-500/20">
                                <div className="flex items-start gap-3">
                                  <Badge variant="outline" className="shrink-0 border-red-500/30 text-red-400 text-xs">
                                    {e.type}
                                  </Badge>
                                  <div className="flex-1 space-y-2">
                                    <p className="text-sm text-foreground">{e.explanation}</p>
                                    {e.summaryExcerpt && (
                                      <div className="text-xs">
                                        <span className="text-muted-foreground">Summary excerpt: </span>
                                        <span className="text-red-400/80 italic">&ldquo;{e.summaryExcerpt}&rdquo;</span>
                                      </div>
                                    )}
                                    {e.sourceReference && (
                                      <div className="text-xs">
                                        <span className="text-muted-foreground">Source reference: </span>
                                        <span className="text-blue-400/80">{e.sourceReference}</span>
                                      </div>
                                    )}
                                    {e.correction && (
                                      <div className="text-xs">
                                        <span className="text-muted-foreground">Correction: </span>
                                        <span className="text-emerald-400/80">{e.correction}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-emerald-400/70 italic">✓ No errors found</p>
                        )}
                      </div>

                      {/* Recommendation - Full Text */}
                      {item.recommendation && (
                        <div className="p-6 border-t border-border/30">
                          <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
                            <p className="text-sm font-semibold text-primary mb-2">Recommendation</p>
                            <p className="text-sm text-muted-foreground leading-relaxed">{item.recommendation}</p>
                          </div>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              </TabsContent>

              {/* Cost Analysis Tab */}
              <TabsContent value="costs">
                <Card>
                  <CardHeader>
                    <CardTitle className="font-serif">Cost Analysis</CardTitle>
                    <CardDescription>
                      Detailed cost breakdown and value comparison
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {rankedModels
                        .sort((a, b) => (a.summary?.costUsd || 0) - (b.summary?.costUsd || 0))
                        .map((item) => (
                          <div
                            key={item.model?.id}
                            className="flex items-center gap-4 p-4 rounded-xl border border-border"
                          >
                            <div className="flex-1">
                              <p className="font-medium">{item.model?.name}</p>
                              <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                                <span>{(item.summary?.inputTokens || 0).toLocaleString()} input</span>
                                <span>{(item.summary?.outputTokens || 0).toLocaleString()} output</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-8">
                              <div className="text-center">
                                <p className="text-lg font-bold">
                                  {formatCurrency(item.summary?.costUsd || 0)}
                                </p>
                                <p className="text-xs text-muted-foreground">Total Cost</p>
                              </div>
                              <div className="text-center">
                                <p
                                  className={cn(
                                    'text-lg font-bold',
                                    getScoreColor(item.overallScore)
                                  )}
                                >
                                  {Math.round(item.overallScore)}
                                </p>
                                <p className="text-xs text-muted-foreground">Score</p>
                              </div>
                              <div className="text-center">
                                <p className="text-lg font-bold text-amber-400">
                                  {item.costEffectiveness.toFixed(0)}
                                </p>
                                <p className="text-xs text-muted-foreground">Score/$</p>
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Detailed Scores Tab */}
              <TabsContent value="details">
                <div className="space-y-6">
                  {rankedModels.map((item) => (
                    <Card key={item.model?.id} className={cn(getScoreGradient(item.overallScore))}>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle className="flex items-center gap-2">
                              <div
                                className="w-3 h-3 rounded-full"
                                style={{ backgroundColor: item.model?.color }}
                              />
                              {item.model?.name}
                              <Badge variant="outline" className="ml-2">#{item.rank}</Badge>
                            </CardTitle>
                            <CardDescription>{item.model?.provider}</CardDescription>
                          </div>
                          <div className="text-right">
                            <p
                              className={cn(
                                'text-3xl font-bold',
                                getScoreColor(item.overallScore)
                              )}
                            >
                              {Math.round(item.overallScore)}
                            </p>
                            <Badge variant="outline" className={getScoreColor(item.overallScore)}>
                              {getScoreLabel(item.overallScore)}
                            </Badge>
                          </div>
                        </div>
                        {item.recommendation && (
                          <p className="text-sm text-muted-foreground mt-2 italic">
                            {item.recommendation}
                          </p>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-6">
                        {/* Score Breakdown - Click to expand rationale */}
                        <div>
                          <p className="text-xs text-muted-foreground mb-3">
                            Click each score to see detailed rationale
                          </p>
                          <div className="space-y-3">
                            <ScoreBar
                              label="Factual Accuracy"
                              score={item.factualAccuracy}
                              weight="25%"
                            />
                            <ScoreBar
                              label="Citation Accuracy"
                              score={item.pageLineAccuracy}
                              weight="20%"
                            />
                            <ScoreBar label="Relevance" score={item.relevance} weight="20%" />
                            <ScoreBar
                              label="Comprehensiveness"
                              score={item.comprehensiveness}
                              weight="15%"
                            />
                            <ScoreBar
                              label="Legal Utility"
                              score={item.legalUtility}
                              weight="20%"
                            />
                          </div>
                        </div>

                        <Separator />

                        {/* Strengths & Weaknesses */}
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm font-medium text-emerald-400 mb-2">
                              Strengths
                            </p>
                            <ul className="space-y-1">
                              {item.strengths.map((s, i) => (
                                <li key={i} className="text-xs text-muted-foreground flex gap-2">
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                                  {s}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-red-400 mb-2">
                              Weaknesses
                            </p>
                            <ul className="space-y-1">
                              {item.weaknesses.map((w, i) => (
                                <li key={i} className="text-xs text-muted-foreground flex gap-2">
                                  <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                                  {w}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        {/* Specific Errors for Spot-Checking */}
                        {item.specificErrors && item.specificErrors.length > 0 && (
                          <>
                            <Separator />
                            <ErrorsList errors={item.specificErrors} />
                          </>
                        )}

                        {/* Missing Items */}
                        {item.missingItems && item.missingItems.length > 0 && (
                          <>
                            <Separator />
                            <MissingItemsList items={item.missingItems} />
                          </>
                        )}

                        {/* Analysis Notes */}
                        {item.analysisNotes && (
                          <>
                            <Separator />
                            <div>
                              <p className="text-xs font-medium text-muted-foreground mb-1">Analysis Notes</p>
                              <p className="text-xs text-muted-foreground">{item.analysisNotes}</p>
                            </div>
                          </>
                        )}

                        {/* Download Button */}
                        <div className="flex justify-end pt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadSummary(item.model?.id || '')}
                            className="gap-2"
                          >
                            <Download className="h-4 w-4" />
                            Download Summary to Review
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>

              {/* Errors Tab - All errors across all models */}
              <TabsContent value="errors">
                <Card>
                  <CardHeader>
                    <CardTitle className="font-serif flex items-center gap-2">
                      <Search className="h-5 w-5" />
                      All Errors for Spot-Checking
                    </CardTitle>
                    <CardDescription>
                      Review specific errors found in each summary. Use the excerpt text to search in the downloaded summary file.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-8">
                    {rankedModels.map((item) => {
                      const errorCount = (item.specificErrors?.length || 0) + (item.missingItems?.length || 0);
                      if (errorCount === 0) {
                        return (
                          <div key={item.model?.id} className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div
                                  className="w-4 h-4 rounded-full"
                                  style={{ backgroundColor: item.model?.color }}
                                />
                                <div>
                                  <span className="font-medium">{item.model?.name}</span>
                                  <p className="text-xs text-muted-foreground">Score: {Math.round(item.overallScore)}/100</p>
                                </div>
                              </div>
                              <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                                <CheckCircle2 className="h-3 w-3 mr-1" />
                                No errors found
                              </Badge>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={item.model?.id} className="space-y-4 p-4 rounded-lg border border-border bg-card/50">
                          {/* Model Header */}
                          <div className="flex items-center justify-between pb-3 border-b border-border">
                            <div className="flex items-center gap-3">
                              <div
                                className="w-4 h-4 rounded-full"
                                style={{ backgroundColor: item.model?.color }}
                              />
                              <div>
                                <span className="font-medium text-lg">{item.model?.name}</span>
                                <div className="flex items-center gap-2 mt-1">
                                  <Badge variant="outline" className="text-muted-foreground">
                                    Score: {Math.round(item.overallScore)}/100
                                  </Badge>
                                  <Badge variant="outline" className="text-red-400 border-red-500/30">
                                    {item.specificErrors?.length || 0} errors
                                  </Badge>
                                  <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                                    {item.missingItems?.length || 0} missing
                                  </Badge>
                                </div>
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadSummary(item.model?.id || '')}
                              className="gap-2"
                            >
                              <Download className="h-4 w-4" />
                              Download Summary
                            </Button>
                          </div>
                          
                          {/* Errors for THIS model */}
                          {item.specificErrors && item.specificErrors.length > 0 && (
                            <ErrorsList errors={item.specificErrors} />
                          )}
                          
                          {/* Missing items for THIS model */}
                          {item.missingItems && item.missingItems.length > 0 && (
                            <MissingItemsList items={item.missingItems} />
                          )}
                        </div>
                      );
                    })}

                    {rankedModels.every(m => (m.specificErrors?.length || 0) + (m.missingItems?.length || 0) === 0) && (
                      <div className="text-center py-8">
                        <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-4" />
                        <p className="text-lg font-medium">No Errors Found</p>
                        <p className="text-muted-foreground">All summaries passed quality checks</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Control Summary Tab */}
              {matter.controlSummary && (
                <TabsContent value="control">
                  <div className="space-y-6">
                    {/* Control Summary Info */}
                    <Card className="border-amber-500/30">
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-amber-500/10">
                              <Shield className="h-5 w-5 text-amber-400" />
                            </div>
                            <div>
                              <CardTitle className="font-serif text-amber-400">
                                Production Control Summary
                              </CardTitle>
                              <CardDescription>
                                This is the baseline output from CaseMark production
                              </CardDescription>
                            </div>
                          </div>
                          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
                            PRODUCTION BASELINE
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {/* Meta Info */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                          <div>
                            <p className="text-xs text-muted-foreground">Source</p>
                            <p className="text-sm font-medium capitalize">
                              {matter.controlSummary.source}
                            </p>
                          </div>
                          {matter.controlSummary.filename && (
                            <div>
                              <p className="text-xs text-muted-foreground">Filename</p>
                              <p className="text-sm font-medium truncate">
                                {matter.controlSummary.filename}
                              </p>
                            </div>
                          )}
                          <div>
                            <p className="text-xs text-muted-foreground">Length</p>
                            <p className="text-sm font-medium">
                              {matter.controlSummary.content.length.toLocaleString()} characters
                            </p>
                          </div>
                          {matter.controlSummary.generatedAt && (
                            <div>
                              <p className="text-xs text-muted-foreground">Added</p>
                              <p className="text-sm font-medium">
                                {new Date(matter.controlSummary.generatedAt).toLocaleDateString()}
                              </p>
                            </div>
                          )}
                        </div>

                        {matter.controlSummary.notes && (
                          <div className="p-3 rounded-lg bg-muted/50 border border-border">
                            <p className="text-sm text-muted-foreground italic">
                              "{matter.controlSummary.notes}"
                            </p>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const blob = new Blob([matter.controlSummary!.content], { type: 'text/plain' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `control-summary-${matter.name.replace(/\s+/g, '-')}.txt`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="gap-1"
                          >
                            <Download className="h-3 w-3" />
                            Download
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(matter.controlSummary!.content);
                            }}
                            className="gap-1"
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </Button>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Control Summary Content */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="font-serif">Summary Content</CardTitle>
                        <CardDescription>
                          The full production summary for comparison
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ScrollArea className="h-[500px] w-full rounded-lg border border-border bg-muted/30 p-4">
                          <pre className="text-sm whitespace-pre-wrap font-mono">
                            {matter.controlSummary.content}
                          </pre>
                        </ScrollArea>
                      </CardContent>
                    </Card>

                    {/* Quick Compare */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="font-serif">Compare with Test Models</CardTitle>
                        <CardDescription>
                          Select a test model summary to compare against the control
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                          {rankedModels.map((item) => (
                            <Button
                              key={item.model?.id}
                              variant="outline"
                              className="h-auto flex-col gap-1 py-3"
                              onClick={() => {
                                // Download both for comparison
                                const controlBlob = new Blob([matter.controlSummary!.content], { type: 'text/plain' });
                                const testBlob = new Blob([item.summary?.content || ''], { type: 'text/plain' });
                                
                                const controlUrl = URL.createObjectURL(controlBlob);
                                const testUrl = URL.createObjectURL(testBlob);
                                
                                const a1 = document.createElement('a');
                                a1.href = controlUrl;
                                a1.download = `control-${matter.name.replace(/\s+/g, '-')}.txt`;
                                a1.click();
                                
                                setTimeout(() => {
                                  const a2 = document.createElement('a');
                                  a2.href = testUrl;
                                  a2.download = `${item.model?.name.replace(/\s+/g, '-')}-${matter.name.replace(/\s+/g, '-')}.txt`;
                                  a2.click();
                                  
                                  URL.revokeObjectURL(controlUrl);
                                  URL.revokeObjectURL(testUrl);
                                }, 100);
                              }}
                            >
                              <div
                                className="w-3 h-3 rounded-full"
                                style={{ backgroundColor: item.model?.color }}
                              />
                              <span className="text-xs font-medium">{item.model?.name}</span>
                              <span className={cn(
                                "text-xs",
                                getScoreColor(item.overallScore)
                              )}>
                                {Math.round(item.overallScore)}
                              </span>
                            </Button>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-3">
                          Click a model to download both control and test summaries for side-by-side comparison
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>
              )}
            </Tabs>

            {/* Chat with Judge Panel */}
            {showChat && (
              <Card id="chat-panel" className="mt-6 border-primary/30 bg-primary/5">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="font-serif flex items-center gap-2 text-lg">
                      <MessageSquare className="h-5 w-5 text-primary" />
                      Ask the Judge
                    </CardTitle>
                    <Badge variant="outline" className="text-xs">
                      {JUDGE_MODEL.name}
                    </Badge>
                  </div>
                  <CardDescription>
                    Ask follow-up questions about the analysis results
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Chat Messages */}
                  <ScrollArea 
                    className="h-[300px] w-full rounded-lg border border-border bg-background/50 p-4" 
                    ref={chatScrollRef}
                  >
                    {chatMessages.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground">
                        <MessageSquare className="h-10 w-10 mb-3 opacity-50" />
                        <p className="text-sm font-medium">Chat with the Judge</p>
                        <p className="text-xs mt-1 max-w-[300px]">
                          I analyzed all {Object.keys(matter?.qualityScores || {}).length} summaries. Ask me about:
                        </p>
                        <ul className="text-xs mt-2 text-left space-y-1">
                          <li>• Cost comparisons vs the Control baseline</li>
                          <li>• Why a model scored higher or lower</li>
                          <li>• Specific errors and their severity</li>
                          <li>• Which model offers the best value</li>
                        </ul>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {chatMessages.map((msg, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              'flex gap-3',
                              msg.role === 'user' ? 'justify-end' : 'justify-start'
                            )}
                          >
                            <div
                              className={cn(
                                'max-w-[80%] rounded-lg px-4 py-2 text-sm',
                                msg.role === 'user'
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted'
                              )}
                            >
                              <p className="whitespace-pre-wrap">{msg.content}</p>
                            </div>
                          </div>
                        ))}
                        {chatLoading && (
                          <div className="flex gap-3 justify-start">
                            <div className="bg-muted rounded-lg px-4 py-2 text-sm flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              <span className="text-muted-foreground">Thinking...</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </ScrollArea>
                  
                  {/* Input */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Ask a question about the results..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendChatMessage()}
                      disabled={chatLoading}
                      className="flex-1 rounded-lg border border-border bg-background px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                    />
                    <Button
                      onClick={sendChatMessage}
                      disabled={!chatInput.trim() || chatLoading}
                      className="gap-2"
                    >
                      {chatLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Send
                    </Button>
                  </div>
                  
                  {/* Suggested Questions */}
                  {chatMessages.length === 0 && (
                    <div className="flex flex-wrap gap-2">
                      {[
                        'Why is the cost so different between models?',
                        'Which model offers the best value?',
                        'What does "-98% cost" mean?',
                        'Why did the #1 model win?',
                        'What were the most serious errors?',
                        'Should we switch from the Control?',
                      ].map((q) => (
                        <Button
                          key={q}
                          variant="outline"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => {
                            setChatInput(q);
                          }}
                        >
                          {q}
                        </Button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Completed but no matching models (old data with different models) */}
        {isCompleted && rankedModels.length === 0 && (
          <div className="space-y-8">
            {/* Source Documents */}
            <Card>
              <CardHeader>
                <CardTitle className="font-serif flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  Source Documents
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {matter.sourceDocuments.map((doc, idx) => (
                    <div
                      key={doc.id || `doc-${idx}`}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50"
                    >
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{doc.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {(doc.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Show existing summaries (only for selected models) */}
            {(() => {
              const selectedModelIds = matter.modelsToTest || TEST_MODELS.map(m => m.id);
              const relevantSummaries = Object.entries(matter.summaries)
                .filter(([modelId]) => selectedModelIds.includes(modelId));
              
              if (relevantSummaries.length === 0) return null;
              
              return (
              <Card>
                <CardHeader>
                  <CardTitle className="font-serif">Previous Summaries</CardTitle>
                  <CardDescription>
                    {relevantSummaries.length} summaries from previous run
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {relevantSummaries.map(([modelId, summary]) => {
                      const model = TEST_MODELS.find(m => m.id === modelId);
                      return (
                        <div
                          key={modelId}
                          className="flex items-center gap-3 p-3 rounded-lg border border-border"
                        >
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: model?.color || '#6b7280' }}
                          />
                          <div className="flex-1">
                            <p className="font-medium">{model?.name || modelId}</p>
                            <p className="text-xs text-muted-foreground">
                              {model?.provider || 'Unknown'} • {formatCurrency(summary.costUsd)} • {formatDuration(summary.elapsedTimeMs)}
                            </p>
                          </div>
                          {summary.status === 'completed' ? (
                            <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Done
                            </Badge>
                          ) : summary.status === 'error' ? (
                            <Badge variant="outline" className="text-red-400 border-red-500/30">
                              <AlertCircle className="h-3 w-3 mr-1" />
                              Error
                            </Badge>
                          ) : (
                            <Badge variant="outline">Pending</Badge>
                          )}
                          {!model && (
                            <Badge variant="outline" className="text-amber-400 border-amber-500/30 text-xs">
                              Model removed
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
              );
            })()}

            {/* Prompt to run missing models only */}
            {(() => {
              // Use only the models selected for this matter
              const selectedModels = matter.modelsToTest 
                ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
                : TEST_MODELS;
              
              // Find models that are missing or failed (only from selected models)
              const missingModels = selectedModels.filter(model => {
                const summary = matter.summaries[model.id];
                return !summary || summary.status !== 'completed';
              });
              
              // Find models that already have good summaries (only from selected models)
              const existingModels = selectedModels.filter(model => {
                const summary = matter.summaries[model.id];
                return summary && summary.status === 'completed';
              });

              if (missingModels.length === 0) {
                // All selected models have summaries - just need analysis
                return (
                  <Card className="border-emerald-500/30 bg-emerald-500/5">
                    <CardHeader>
                      <CardTitle className="font-serif flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                        All Summaries Complete
                      </CardTitle>
                      <CardDescription>
                        All {selectedModels.length} selected models have completed summaries. Run quality analysis to compare.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button variant="gold" onClick={runQualityAnalysis} className="gap-2">
                        <BarChart3 className="h-4 w-4" />
                        Run Quality Analysis
                      </Button>
                    </CardContent>
                  </Card>
                );
              }

              return (
                <Card className="border-primary/30 bg-primary/5">
                  <CardHeader>
                    <CardTitle className="font-serif flex items-center gap-2">
                      <RefreshCw className="h-5 w-5 text-primary" />
                      {missingModels.length === selectedModels.length 
                        ? 'Run All Models' 
                        : `Run ${missingModels.length} Missing Model${missingModels.length > 1 ? 's' : ''}`}
                    </CardTitle>
                    <CardDescription>
                      {existingModels.length > 0 
                        ? `${existingModels.length} model${existingModels.length > 1 ? 's' : ''} already have summaries. Only run the missing ones.`
                        : 'Generate summaries with all selected models.'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Missing models */}
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">
                        {missingModels.length === selectedModels.length ? 'Models to run:' : 'Missing models:'}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {missingModels.map(model => (
                          <Badge key={model.id} variant="outline" className="gap-1 border-primary/50">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: model.color }} />
                            {model.name}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {/* Existing models */}
                    {existingModels.length > 0 && (
                      <div>
                        <p className="text-sm text-muted-foreground mb-2">Already have summaries:</p>
                        <div className="flex flex-wrap gap-2">
                          {existingModels.map(model => (
                            <Badge key={model.id} variant="outline" className="gap-1 text-emerald-400 border-emerald-500/30">
                              <CheckCircle2 className="h-3 w-3" />
                              {model.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex gap-3 pt-2">
                      <Button variant="gold" onClick={() => runMissingModels(missingModels.map(m => m.id))} className="gap-2">
                        <Sparkles className="h-4 w-4" />
                        Run {missingModels.length} Missing
                      </Button>
                      {existingModels.length > 0 && (
                        <Button variant="outline" onClick={startProcessing} className="gap-2">
                          <RefreshCw className="h-4 w-4" />
                          Rerun All {selectedModels.length}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}
          </div>
        )}

        {/* Error State */}
        {matter.status === 'error' && (
          <div className="max-w-md mx-auto text-center">
            <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">Processing Failed</h3>
            <p className="text-muted-foreground mb-4">
              {matter.error || 'An error occurred during processing'}
            </p>
            <Button onClick={startProcessing}>Retry</Button>
          </div>
        )}

        {/* Cancelled State */}
        {matter.status === 'cancelled' && (
          <div className="max-w-md mx-auto text-center">
            <XCircle className="h-12 w-12 text-amber-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">Processing Cancelled</h3>
            <p className="text-muted-foreground mb-4">
              The processing was cancelled. Any completed summaries have been preserved.
            </p>
            <div className="flex gap-2 justify-center">
              {Object.keys(matter.summaries).length > 0 && (
                <Button variant="outline" onClick={() => {
                  // Just show results for existing summaries
                  const completedCount = Object.values(matter.summaries).filter(s => s.status === 'completed').length;
                  toast({
                    title: 'Existing Summaries',
                    description: `You have ${completedCount} completed summaries. Click "Resume" to continue with remaining models.`,
                  });
                }}>
                  View Results
                </Button>
              )}
              <Button onClick={startProcessing}>
                {Object.keys(matter.summaries).length > 0 ? 'Resume' : 'Start Again'}
              </Button>
            </div>
          </div>
        )}

        {/* Initial State - Ready to Process */}
        {matter.status === 'created' && !processing && (
          <div className="space-y-6">
            {/* Source Document */}
            <Card>
              <CardHeader>
                <CardTitle className="font-serif flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  Source Document
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {matter.sourceDocuments.map((doc, idx) => (
                    <div
                      key={doc.id || `doc-${idx}`}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50"
                    >
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{doc.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {doc.content ? `${doc.content.length.toLocaleString()} chars extracted` : `${(doc.size / 1024).toFixed(1)} KB`}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Ready</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Control Summary */}
            {matter.controlSummary && (
              <Card className="border-amber-500/30 bg-amber-500/5">
                <CardHeader>
                  <CardTitle className="font-serif flex items-center gap-2">
                    <Shield className="h-5 w-5 text-amber-400" />
                    Control Summary (Production Baseline)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10">
                    <FileText className="h-5 w-5 text-amber-400" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{matter.controlSummary.filename || 'Control Summary'}</p>
                      <p className="text-xs text-muted-foreground">
                        {matter.controlSummary.content.length.toLocaleString()} characters
                        {matter.controlSummary.notes && ` • ${matter.controlSummary.notes}`}
                      </p>
                    </div>
                    <Badge variant="outline" className="border-amber-500/50 text-amber-400">CONTROL</Badge>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Models to Test */}
            {matter.modelsToTest && matter.modelsToTest.length > 0 && (
              <Card className="border-primary/30">
                <CardHeader>
                  <CardTitle className="font-serif flex items-center gap-2">
                    <Target className="h-5 w-5 text-primary" />
                    Models to Test ({matter.modelsToTest.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {matter.modelsToTest.map((modelId) => {
                      const model = TEST_MODELS.find(m => m.id === modelId);
                      return (
                        <Badge key={modelId} variant="outline" className="gap-1">
                          <div 
                            className="w-2 h-2 rounded-full" 
                            style={{ backgroundColor: model?.color || '#888' }}
                          />
                          {model?.name || modelId}
                        </Badge>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Start Processing CTA */}
            <div className="max-w-md mx-auto text-center pt-4">
              <Scale className="h-12 w-12 text-primary mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">Ready to Generate & Compare</h3>
              <p className="text-muted-foreground mb-4">
                Generate summaries with {matter.modelsToTest?.length || TEST_MODELS.length} models, then analyze quality against your control
              </p>
              <Button variant="gold" onClick={startProcessing} className="gap-2">
                <Sparkles className="h-4 w-4" />
                Start Comparison
              </Button>
            </div>
          </div>
        )}

        {/* Fallback - No Results Yet (completed but no scores, or unknown state) */}
        {!isProcessing && !isCompleted && matter.status !== 'created' && matter.status !== 'error' && (
          <div className="space-y-8">
            {/* Source Documents */}
            <Card>
              <CardHeader>
                <CardTitle className="font-serif flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  Source Documents
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {matter.sourceDocuments.length > 0 ? (
                    matter.sourceDocuments.map((doc, idx) => (
                      <div
                        key={doc.id || `doc-${idx}`}
                        className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50"
                      >
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{doc.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {(doc.size / 1024).toFixed(1)} KB
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-muted-foreground text-sm">No documents found</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Summaries if any */}
            {Object.keys(matter.summaries).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-serif">Generated Summaries</CardTitle>
                  <CardDescription>
                    {Object.values(matter.summaries).filter(s => s.status === 'completed').length} of {matter.modelsToTest?.length || TEST_MODELS.length} summaries completed
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {/* Only show models that were selected for this comparison */}
                    {(matter.modelsToTest 
                      ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
                      : TEST_MODELS
                    ).map((model) => {
                      const summary = matter.summaries[model.id];
                      return (
                        <div
                          key={model.id}
                          className="flex items-center gap-3 p-3 rounded-lg border border-border"
                        >
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: model.color }}
                          />
                          <div className="flex-1">
                            <p className="font-medium">{model.name}</p>
                            <p className="text-xs text-muted-foreground">{model.provider}</p>
                          </div>
                          {summary ? (
                            summary.status === 'completed' ? (
                              <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                                <CheckCircle2 className="h-3 w-3 mr-1" />
                                Done
                              </Badge>
                            ) : summary.status === 'error' ? (
                              <Badge variant="outline" className="text-red-400 border-red-500/30">
                                <AlertCircle className="h-3 w-3 mr-1" />
                                Error
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                Running
                              </Badge>
                            )
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">
                              Pending
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Debug Info & Retry */}
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader>
                <CardTitle className="font-serif flex items-center gap-2 text-amber-400">
                  <AlertCircle className="h-5 w-5" />
                  Incomplete Processing
                </CardTitle>
                <CardDescription>
                  Status: <code className="text-xs bg-muted px-1 py-0.5 rounded">{matter.status}</code>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Processing may have been interrupted. You can restart to continue.
                </p>
                <div className="flex gap-3">
                  <Button variant="gold" onClick={startProcessing} className="gap-2">
                    <Sparkles className="h-4 w-4" />
                    Restart Processing
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Summary Status Panel - Shows when there are summaries but processing might be incomplete */}
        {Object.keys(matter.summaries).length > 0 && !isProcessing && (
          (() => {
            // Use only the models selected for this matter
            const selectedModels = matter.modelsToTest 
              ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
              : TEST_MODELS;
            
            // Count only summaries for selected models
            const selectedModelIds = selectedModels.map(m => m.id);
            const completedCount = Object.entries(matter.summaries)
              .filter(([id, s]) => selectedModelIds.includes(id) && s.status === 'completed').length;
            const errorCount = Object.entries(matter.summaries)
              .filter(([id, s]) => selectedModelIds.includes(id) && s.status === 'error').length;
            const pendingCount = selectedModels.length - 
              Object.keys(matter.summaries).filter(id => selectedModelIds.includes(id)).length;
            const hasIncomplete = errorCount > 0 || pendingCount > 0;
            const hasQualityScores = Object.keys(matter.qualityScores).some(id => selectedModelIds.includes(id));
            const analysisCount = Object.keys(matter.qualityScores).filter(id => selectedModelIds.includes(id)).length;
            const needsAnalysis = completedCount > 0 && analysisCount < completedCount;
            
            // Don't show if everything is complete and analyzed
            if (!hasIncomplete && !needsAnalysis && hasQualityScores) return null;

            return (
              <div className="space-y-6 mb-8">
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="font-serif flex items-center gap-2">
                          Summary Generation Status
                          {hasIncomplete && (
                            <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                              {errorCount + pendingCount} incomplete
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription>
                          {completedCount} of {selectedModels.length} summaries completed
                          {needsAnalysis && ` • ${analysisCount} analyzed`}
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={refreshAllJobs}
                          disabled={refreshingAll || retryingModels.size > 0}
                          className="gap-2"
                        >
                          <RefreshCw className={cn("h-4 w-4", refreshingAll && "animate-spin")} />
                          {refreshingAll && refreshProgress 
                            ? `${refreshProgress.current}/${refreshProgress.total}: ${refreshProgress.modelName.substring(0, 15)}...`
                            : 'Refresh All'}
                        </Button>
                        {hasIncomplete && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={retryAllFailed}
                            disabled={retryingModels.size > 0 || refreshingAll}
                            className="gap-2"
                          >
                            <RefreshCw className={cn("h-4 w-4", retryingModels.size > 0 && "animate-spin")} />
                            Retry Failed
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {/* Only show models that were selected for this comparison */}
                      {(matter.modelsToTest 
                        ? TEST_MODELS.filter(m => matter.modelsToTest!.includes(m.id))
                        : TEST_MODELS
                      ).map((model) => {
                        const summary = matter.summaries[model.id];
                        const isRetrying = retryingModels.has(model.id);
                        const hasAnalysis = matter.qualityScores[model.id];
                        
                        return (
                          <div
                            key={model.id}
                            className={cn(
                              "flex items-center gap-3 p-3 rounded-lg border",
                              summary?.status === 'completed' 
                                ? "border-emerald-500/30 bg-emerald-500/5" 
                                : summary?.status === 'completed_no_download'
                                ? "border-amber-500/30 bg-amber-500/5"
                                : summary?.status === 'error'
                                ? "border-red-500/30 bg-red-500/5"
                                : "border-border"
                            )}
                          >
                            <div
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: model.color }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium">{model.name}</p>
                              <p className="text-xs text-muted-foreground truncate">
                                {model.provider}
                                {model.notes && ` • ${model.notes}`}
                              </p>
                            </div>
                            
                            {/* Status & Actions */}
                            <div className="flex items-center gap-2 shrink-0">
                              {isRetrying ? (
                                <Badge variant="outline" className="gap-1">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Generating...
                                </Badge>
                              ) : analyzingModels.has(model.id) ? (
                                <Badge variant="outline" className="gap-1 text-blue-400 border-blue-500/30 animate-pulse">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Analyzing with GPT-5.2...
                                </Badge>
                              ) : extractingModels.has(model.id) ? (
                                <Badge variant="outline" className="gap-1 text-amber-400 border-amber-500/30 animate-pulse">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Extracting text...
                                </Badge>
                              ) : summary?.status === 'completed' ? (
                                <>
                                  <span className="text-xs text-muted-foreground">
                                    {formatCurrency(summary.costUsd)} • {formatDuration(summary.elapsedTimeMs)}
                                  </span>
                                  {hasAnalysis ? (
                                    <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                                      <CheckCircle2 className="h-3 w-3 mr-1" />
                                      Analyzed
                                    </Badge>
                                  ) : runningAnalysis ? (
                                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                                      <Clock className="h-3 w-3" />
                                      Queued
                                    </Badge>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => analyzeSingleSummary(model.id)}
                                      disabled={runningAnalysis || analyzingModelId === model.id}
                                      className="gap-1 text-xs text-blue-400 border-blue-500/30 hover:bg-blue-500/10"
                                    >
                                      {analyzingModelId === model.id ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <BarChart3 className="h-3 w-3" />
                                      )}
                                      Analyze
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => downloadSummary(model.id)}
                                    className="h-8 w-8 p-0"
                                  >
                                    <Download className="h-4 w-4" />
                                  </Button>
                                </>
                              ) : summary?.status === 'completed_no_download' ? (
                                <>
                                  <span className="text-xs text-muted-foreground">
                                    {formatDuration(summary.elapsedTimeMs)}
                                  </span>
                                  {hasAnalysis ? (
                                    <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                                      <CheckCircle2 className="h-3 w-3 mr-1" />
                                      Analyzed
                                    </Badge>
                                  ) : runningAnalysis ? (
                                    <Badge variant="outline" className="gap-1 text-amber-400 border-amber-500/30">
                                      <Clock className="h-3 w-3" />
                                      Queued for extraction
                                    </Badge>
                                  ) : (
                                    <>
                                      <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                                        <CheckCircle2 className="h-3 w-3 mr-1" />
                                        CaseMark Done
                                      </Badge>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => downloadSummaryContent(model.id)}
                                        disabled={retryingModels.has(model.id)}
                                        className="gap-1 text-xs text-emerald-400 border-emerald-500/30"
                                      >
                                        {retryingModels.has(model.id) ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Download className="h-3 w-3" />
                                        )}
                                        Download
                                      </Button>
                                    </>
                                  )}
                                </>
                              ) : summary?.status === 'error' ? (
                                <>
                                  <span className="text-xs text-red-400 max-w-[180px] truncate" title={summary.error}>
                                    {summary.error}
                                  </span>
                                  {summary.casemarkWorkflowId ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => checkWorkflowStatus(model.id)}
                                      disabled={isRetrying}
                                      className="gap-1 text-xs text-blue-400 border-blue-500/30"
                                    >
                                      <RefreshCw className={cn("h-3 w-3", isRetrying && "animate-spin")} />
                                      Check Status
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => retrySingleModel(model.id)}
                                      disabled={isRetrying}
                                      className="gap-1 text-xs"
                                    >
                                      <RefreshCw className="h-3 w-3" />
                                      Retry
                                    </Button>
                                  )}
                                </>
                              ) : summary?.status === 'generating' ? (
                                <>
                                  <span className="text-xs text-blue-400">
                                    CaseMark processing...
                                  </span>
                                  {summary.casemarkWorkflowId && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => checkWorkflowStatus(model.id)}
                                      disabled={isRetrying}
                                      className="gap-1 text-xs text-blue-400 border-blue-500/30"
                                    >
                                      <RefreshCw className={cn("h-3 w-3", isRetrying && "animate-spin")} />
                                      Check
                                    </Button>
                                  )}
                                  <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                                </>
                              ) : (
                                <>
                                  <Badge variant="outline" className="text-muted-foreground">
                                    Not started
                                  </Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => retrySingleModel(model.id)}
                                    disabled={isRetrying}
                                    className="gap-1 text-xs"
                                  >
                                    <Sparkles className="h-3 w-3" />
                                    Generate
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                {/* Action buttons */}
                <div className="flex items-center justify-center gap-4">
                  {needsAnalysis && completedCount > 0 && (
                    <Button
                      variant="gold"
                      onClick={runQualityAnalysis}
                      disabled={runningAnalysis}
                      className="gap-2"
                    >
                      {runningAnalysis ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {analysisProgress 
                            ? `Analyzing ${analysisProgress.currentModel} (${analysisProgress.current}/${analysisProgress.total})...`
                            : `Analyzing ${completedCount} summaries...`
                          }
                        </>
                      ) : (
                        <>
                          <BarChart3 className="h-4 w-4" />
                          Run Quality Analysis ({completedCount} summaries)
                        </>
                      )}
                    </Button>
                  )}
                  {hasIncomplete && (
                    <Button
                      variant="outline"
                      onClick={startProcessing}
                      className="gap-2"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Re-run All from Scratch
                    </Button>
                  )}
                </div>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}

// Helper to get score value from CategoryScore or number (backwards compatible)
function getScoreValue(score: CategoryScore | number): number {
  return typeof score === 'number' ? score : score.score;
}

function ScoreBar({
  label,
  score,
  weight,
}: {
  label: string;
  score: CategoryScore | number;
  weight: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const scoreValue = getScoreValue(score);
  const hasDetails = typeof score === 'object' && (score.rationale || (score.examples && score.examples.length > 0));

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          "w-full text-left",
          hasDetails && "cursor-pointer hover:bg-white/5 rounded -mx-1 px-1"
        )}
      >
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground flex items-center gap-1">
            {label} <span className="text-xs opacity-50">({weight})</span>
            {hasDetails && (
              <ChevronDown className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-180"
              )} />
            )}
          </span>
          <span className={cn('font-medium', getScoreColor(scoreValue))}>{Math.round(scoreValue)}</span>
        </div>
        <div className="h-3 rounded-full bg-secondary overflow-hidden mt-1">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              scoreValue >= 80
                ? 'bg-emerald-500'
                : scoreValue >= 60
                ? 'bg-teal-500'
                : scoreValue >= 40
                ? 'bg-amber-500'
                : 'bg-red-500'
            )}
            style={{ width: `${scoreValue}%` }}
          />
        </div>
      </button>
      {expanded && typeof score === 'object' && (
        <div className="mt-2 ml-1 pl-3 border-l-2 border-muted space-y-2 text-xs">
          {score.rationale && (
            <p className="text-muted-foreground">{score.rationale}</p>
          )}
          {score.examples && score.examples.length > 0 && (
            <div className="space-y-1">
              {score.examples.map((ex, i) => (
                <p key={i} className="text-muted-foreground italic">"{ex}"</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Component to display specific errors for spot-checking
function ErrorsList({ errors }: { errors: SpecificError[] }) {
  if (!errors || errors.length === 0) return null;

  const severityColors = {
    critical: 'border-red-500 bg-red-500/10 text-red-400',
    major: 'border-amber-500 bg-amber-500/10 text-amber-400',
    minor: 'border-blue-500 bg-blue-500/10 text-blue-400',
  };

  const typeLabels = {
    factual: 'Factual Error',
    citation: 'Citation Error',
    omission: 'Omission',
    hallucination: 'Hallucination',
    misinterpretation: 'Misinterpretation',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-red-400">
        <AlertCircle className="h-4 w-4" />
        Specific Errors Found ({errors.length})
      </div>
      <div className="space-y-2">
        {errors.map((error, i) => (
          <div
            key={i}
            className={cn(
              'p-3 rounded-lg border-l-4',
              severityColors[error.severity] || severityColors.minor
            )}
          >
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className="text-[10px]">
                {typeLabels[error.type] || error.type}
              </Badge>
              <Badge variant="outline" className="text-[10px] capitalize">
                {error.severity}
              </Badge>
              {error.sourceReference && (
                <span className="text-[10px] text-muted-foreground">
                  Source: {error.sourceReference}
                </span>
              )}
            </div>
            {error.summaryExcerpt && (
              <div className="mb-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  Search in summary for:
                </p>
                <code className="block text-xs bg-black/30 p-2 rounded font-mono break-all select-all">
                  {error.summaryExcerpt}
                </code>
              </div>
            )}
            <p className="text-xs">{error.explanation}</p>
            {error.correction && (
              <div className="mt-2 pt-2 border-t border-white/10">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  Should be:
                </p>
                <p className="text-xs text-emerald-400">{error.correction}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Component to display missing items
function MissingItemsList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
        <AlertCircle className="h-4 w-4" />
        Missing from Summary ({items.length})
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-xs text-muted-foreground flex gap-2">
            <span className="text-amber-400">•</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}


