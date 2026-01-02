'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { 
  ArrowLeft, 
  ArrowRight, 
  FileText, 
  Stethoscope, 
  Sparkles, 
  Shield, 
  Upload,
  CheckCircle2,
  Loader2,
  FileStack,
  Cpu,
  Check,
  AlertCircle,
  Info
} from 'lucide-react';
import Link from 'next/link';
import { 
  Matter, 
  SummaryType, 
  TEST_MODELS, 
  JUDGE_MODEL,
  SUMMARY_TYPE_INFO,
  PRIMARY_SUMMARY_TYPES,
  ALL_SUMMARY_TYPES,
} from '@/lib/types';
import { saveMatter, createMatterId } from '@/lib/storage';
import { cn, formatCurrency } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';

export default function NewMatterPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  
  // Step 1: Matter details + File uploads (no processing)
  const [matterName, setMatterName] = useState('');
  const [summaryType, setSummaryType] = useState<SummaryType | ''>('');
  
  // Files (just store the File objects, no processing yet)
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [isDraggingSource, setIsDraggingSource] = useState(false);
  
  // Step 2: Model Selection
  const [selectedModels, setSelectedModels] = useState<string[]>(
    TEST_MODELS.map(m => m.id) // All selected by default
  );
  
  const [isCreating, setIsCreating] = useState(false);

  // Helper functions for file type detection
  const isTextFile = (file: File): boolean => {
    return file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt');
  };

  const isValidSourceFile = (file: File): boolean => {
    const validTypes = ['application/pdf', 'text/plain'];
    const validExtensions = ['.pdf', '.txt'];
    return validTypes.includes(file.type) || 
           validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
  };

  // Validation
  const canProceedStep1 = matterName.trim() && summaryType && sourceFile;
  const canProceedStep2 = selectedModels.length > 0;

  // Estimate costs based on document type and size
  const isSourceTextFile = sourceFile ? isTextFile(sourceFile) : false;
  
  // For text files: ~4 characters per token (file size in bytes ≈ characters for plain text)
  // For PDFs: estimate based on file size (~50KB per page, ~2000 tokens per page)
  const estimatedTokens = sourceFile 
    ? isSourceTextFile 
      ? Math.ceil(sourceFile.size / 4) // Text file: bytes ≈ chars, ~4 chars per token
      : Math.ceil(sourceFile.size / 50000) * 2000 // PDF: ~50KB/page, ~2000 tokens/page
    : 0;
  
  // Page count only makes sense for PDFs
  const estimatePageCount = sourceFile && !isSourceTextFile 
    ? Math.ceil(sourceFile.size / 50000) 
    : undefined;
  
  const estimateSummaryCost = (model: typeof TEST_MODELS[0]) => {
    // Estimate: input tokens + output tokens (output ~20% of input)
    const outputTokens = estimatedTokens * 0.2;
    return ((estimatedTokens / 1_000_000) * model.inputPricePer1M) + 
           ((outputTokens / 1_000_000) * model.outputPricePer1M);
  };

  const totalEstimatedCost = selectedModels.reduce((sum, modelId) => {
    const model = TEST_MODELS.find(m => m.id === modelId);
    return sum + (model ? estimateSummaryCost(model) : 0);
  }, 0);

  // Analysis cost estimate
  const analysisTokens = selectedModels.length * 10000; // ~10k tokens per analysis
  const analysisCost = ((analysisTokens / 1_000_000) * JUDGE_MODEL.inputPricePer1M) +
                       ((analysisTokens * 0.3 / 1_000_000) * JUDGE_MODEL.outputPricePer1M);

  const handleSourceDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingSource(false);
    const file = e.dataTransfer.files[0];
    if (file && isValidSourceFile(file)) {
      setSourceFile(file);
      const fileType = isTextFile(file) ? 'text file (no OCR needed)' : 'PDF';
      toast({
        title: 'File selected',
        description: `${file.name} - ${fileType}`,
      });
    } else {
      toast({
        title: 'Invalid file',
        description: 'Please upload a PDF or TXT file',
        variant: 'destructive',
      });
    }
  };

  const toggleModel = (modelId: string) => {
    setSelectedModels(prev => 
      prev.includes(modelId) 
        ? prev.filter(id => id !== modelId)
        : [...prev, modelId]
    );
  };

  const handleCreate = async () => {
    if (!canProceedStep1 || !canProceedStep2 || !sourceFile) return;

    setIsCreating(true);

    try {
      // Create the matter object
      // Note: We're NOT processing the PDFs here - that happens on the matter detail page
      // Control summary is now generated automatically using default model settings
      const matter: Matter = {
        id: createMatterId(),
        name: matterName.trim(),
        vaultId: null, // Will be set during processing
        summaryType: summaryType as SummaryType,
        status: 'created',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceDocuments: [{
          id: `doc_${Date.now()}`,
          filename: sourceFile.name,
          objectId: '', // Will be set during processing
          size: sourceFile.size,
          contentType: sourceFile.type || 'application/pdf',
          content: '', // Will be extracted during processing
        }],
        modelsToTest: selectedModels,
        summaries: {},
        qualityScores: {},
      };

      // Store the source file in sessionStorage for retrieval on the matter page
      const reader = new FileReader();
      reader.onload = () => {
        sessionStorage.setItem(`source_file_${matter.id}`, reader.result as string);
      };
      reader.readAsDataURL(sourceFile);

      // Save matter to storage
      saveMatter(matter);

      toast({
        title: 'Matter created',
        description: 'Starting document processing...',
      });

      // Navigate to the matter page with auto-start
      router.push(`/matter/${matter.id}?start=true`);
    } catch (error) {
      console.error('Failed to create matter:', error);
      toast({
        title: 'Error creating matter',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsCreating(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="text-muted-foreground hover:text-foreground mb-4 inline-block">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-3xl font-serif font-bold">New Summary Comparison</h1>
          <p className="text-muted-foreground mt-1">
            Configure your comparison, then start processing
          </p>
        </div>

        {/* Progress Steps - Now 3 steps */}
        <div className="flex items-center gap-4 mb-8">
          {[
            { num: 1, label: 'Details & Upload' },
            { num: 2, label: 'Models to Test' },
            { num: 3, label: 'Review & Start' },
          ].map((s, i) => (
            <div key={s.num} className="flex items-center gap-2 flex-1">
              <div className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                step > s.num ? 'bg-emerald-500 text-white' :
                step === s.num ? 'bg-primary text-primary-foreground' :
                'bg-muted text-muted-foreground'
              )}>
                {step > s.num ? <Check className="h-4 w-4" /> : s.num}
              </div>
              <span className={cn(
                'text-sm hidden sm:inline',
                step === s.num ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}>
                {s.label}
              </span>
              {i < 2 && <div className="flex-1 h-px bg-border" />}
            </div>
          ))}
        </div>

        <Card>
          {/* Step 1: Details + File Upload */}
          {step === 1 && (
            <>
              <CardHeader>
                <CardTitle className="font-serif">Matter Details & Documents</CardTitle>
                <CardDescription>
                  Enter the comparison details and upload your documents
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Matter Details */}
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Comparison Name</Label>
                    <Input
                      id="name"
                      placeholder="e.g., Smith v. Jones - Plaintiff Deposition"
                      value={matterName}
                      onChange={(e) => setMatterName(e.target.value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <Label>CaseMark Workflow Type</Label>
                    
                    {/* Primary workflow types - shown prominently */}
                    <div className="grid grid-cols-2 gap-4">
                      {PRIMARY_SUMMARY_TYPES.map((type) => {
                        const info = SUMMARY_TYPE_INFO[type];
                        const Icon = info.icon === 'deposition' ? FileText : 
                                     info.icon === 'medical' ? Stethoscope : FileStack;
                        return (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setSummaryType(type)}
                            className={cn(
                              'p-4 rounded-xl border-2 transition-all text-left',
                              summaryType === type
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-primary/50'
                            )}
                          >
                            <Icon className="h-6 w-6 mb-2 text-primary" />
                            <p className="font-medium">{info.label}</p>
                            <p className="text-sm text-muted-foreground line-clamp-2">
                              {info.description}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                    
                    {/* Other workflow types - shown in a compact list */}
                    <details className="group">
                      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2 py-2">
                        <span className="text-xs">▶</span>
                        <span className="group-open:hidden">Show more workflow types</span>
                        <span className="hidden group-open:inline">Hide other workflow types</span>
                      </summary>
                      <div className="mt-2 space-y-1 pl-4 border-l-2 border-border">
                        {ALL_SUMMARY_TYPES.filter(t => !PRIMARY_SUMMARY_TYPES.includes(t)).map((type) => {
                          const info = SUMMARY_TYPE_INFO[type];
                          const Icon = info.icon === 'deposition' ? FileText : 
                                       info.icon === 'medical' ? Stethoscope : FileStack;
                          return (
                            <button
                              key={type}
                              type="button"
                              onClick={() => setSummaryType(type)}
                              className={cn(
                                'w-full p-3 rounded-lg border transition-all text-left flex items-center gap-3',
                                summaryType === type
                                  ? 'border-primary bg-primary/5'
                                  : 'border-transparent hover:border-border hover:bg-muted/50'
                              )}
                            >
                              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium">{info.label}</p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {info.description}
                                </p>
                              </div>
                              {summaryType === type && (
                                <Check className="h-4 w-4 text-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </details>
                  </div>
                </div>

                <Separator />

                {/* File Uploads */}
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <FileText className="h-4 w-4 text-primary" />
                      <Label className="text-base font-medium">Source Document</Label>
                      <Badge variant="destructive" className="text-xs">Required</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      Upload the original transcript or medical records
                    </p>
                    
                    {sourceFile ? (
                      <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5">
                        <div className="flex items-center gap-3">
                          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{sourceFile.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {formatFileSize(sourceFile.size)} • ~{estimatedTokens.toLocaleString()} tokens
                              {estimatePageCount && ` • ~${estimatePageCount} pages`}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSourceFile(null)}
                          >
                            Change
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={cn(
                          'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
                          isDraggingSource ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                        )}
                        onDragOver={(e) => { e.preventDefault(); setIsDraggingSource(true); }}
                        onDragLeave={() => setIsDraggingSource(false)}
                        onDrop={handleSourceDrop}
                        onClick={() => document.getElementById('source-file')?.click()}
                      >
                        <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
                        <p className="font-medium">Drop PDF here or click to browse</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          PDF or TXT file (TXT files skip OCR)
                        </p>
                        <input
                          id="source-file"
                          type="file"
                          accept=".pdf,.txt,application/pdf,text/plain"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file && isValidSourceFile(file)) {
                              setSourceFile(file);
                              const fileType = isTextFile(file) ? 'text file (no OCR)' : 'PDF';
                              toast({ title: 'File selected', description: `${file.name} - ${fileType}` });
                            }
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer */}
                <div className="flex justify-between pt-4">
                  <Button variant="outline" asChild>
                    <Link href="/">
                      <ArrowLeft className="h-4 w-4 mr-2" />
                      Cancel
                    </Link>
                  </Button>
                  <Button 
                    onClick={() => setStep(2)} 
                    disabled={!canProceedStep1}
                  >
                    Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {/* Step 2: Model Selection */}
          {step === 2 && (
            <>
              <CardHeader>
                <CardTitle className="font-serif">Select Models to Test</CardTitle>
                <CardDescription>
                  Choose which LLM models to generate summaries with
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Info banner */}
                {sourceFile && (
                  <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
                    <div className="flex items-center gap-3">
                      <Info className="h-5 w-5 text-primary" />
                      <div>
                        <p className="font-medium">Estimated document size</p>
                        <p className="text-sm text-muted-foreground">
                          {formatFileSize(sourceFile.size)} • ~{estimatedTokens.toLocaleString()} tokens
                          {estimatePageCount ? ` • ~${estimatePageCount} pages` : ' (text file)'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Model Selection */}
                <div className="space-y-3">
                  {TEST_MODELS.map((model) => {
                    const isSelected = selectedModels.includes(model.id);
                    const cost = estimateSummaryCost(model);
                    
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => toggleModel(model.id)}
                        className={cn(
                          'w-full p-4 rounded-xl border-2 transition-all text-left flex items-center gap-4',
                          isSelected
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/30'
                        )}
                      >
                        <div className={cn(
                          'w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors',
                          isSelected ? 'border-primary bg-primary' : 'border-muted-foreground'
                        )}>
                          {isSelected && <Check className="h-4 w-4 text-primary-foreground" />}
                        </div>
                        
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: model.color }}
                        />
                        
                        <div className="flex-1">
                          <p className="font-medium">{model.name}</p>
                          <p className="text-sm text-muted-foreground">{model.provider}</p>
                        </div>
                        
                        <div className="text-right">
                          <p className="font-medium">{formatCurrency(cost)}</p>
                          <p className="text-xs text-muted-foreground">est. cost</p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Cost Summary */}
                <div className="p-4 rounded-xl bg-muted">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-medium">{selectedModels.length} models selected</p>
                      <p className="text-sm text-muted-foreground">
                        + Quality analysis with {JUDGE_MODEL.name}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold">{formatCurrency(totalEstimatedCost + analysisCost)}</p>
                      <p className="text-xs text-muted-foreground">estimated total</p>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(1)}>
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button 
                    onClick={() => setStep(3)} 
                    disabled={!canProceedStep2}
                  >
                    Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {/* Step 3: Review & Start */}
          {step === 3 && (
            <>
              <CardHeader>
                <CardTitle className="font-serif">Review & Start Processing</CardTitle>
                <CardDescription>
                  Confirm your settings and start the comparison
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Summary */}
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-muted">
                    <h3 className="font-medium mb-3">Comparison Details</h3>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Name</p>
                        <p className="font-medium">{matterName}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Type</p>
                        <p className="font-medium capitalize">{summaryType} Analysis</p>
                      </div>
                    </div>
                  </div>

                  {/* Models to Test - Prominent display */}
                  <div className="p-4 rounded-xl bg-primary/5 border border-primary/30">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-medium flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-primary" />
                        Models to Test
                      </h3>
                      <span className="text-sm text-muted-foreground">
                        {selectedModels.length} of {TEST_MODELS.length}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedModels.map(modelId => {
                        const model = TEST_MODELS.find(m => m.id === modelId);
                        if (!model) return null;
                        return (
                          <div 
                            key={model.id}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border"
                          >
                            <div 
                              className="w-2.5 h-2.5 rounded-full" 
                              style={{ backgroundColor: model.color }}
                            />
                            <span className="text-sm font-medium">{model.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatCurrency(estimateSummaryCost(model))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground mt-3">
                      Each model will generate a summary via CaseMark API, then GPT-5.2 analyzes quality
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
                      <div className="flex items-center gap-2 mb-2">
                        <FileText className="h-4 w-4 text-primary" />
                        <p className="font-medium">Source Document</p>
                      </div>
                      <p className="text-sm truncate">{sourceFile?.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {sourceFile && formatFileSize(sourceFile.size)}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                      <div className="flex items-center gap-2 mb-2">
                        <Shield className="h-4 w-4 text-amber-400" />
                        <p className="font-medium">Control (Auto-Generated)</p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Using default production model settings
                      </p>
                    </div>
                  </div>
                </div>

                {/* What will happen */}
                <div className="p-4 rounded-xl border border-border">
                  <h3 className="font-medium mb-3 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    Processing Steps
                  </h3>
                  <ol className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center">1</span>
                      <span>Upload & extract text from source document</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center">2</span>
                      <span>Generate {selectedModels.length} summaries via CaseMark API (includes control)</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center">3</span>
                      <span>Analyze quality with {JUDGE_MODEL.name}</span>
                    </li>
                  </ol>
                  <p className="text-xs text-muted-foreground mt-3">
                    Estimated time: 5-15 minutes depending on document size
                  </p>
                </div>

                {/* Cost estimate */}
                <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-medium text-emerald-400">Estimated Cost</p>
                      <p className="text-sm text-muted-foreground">
                        Summaries ({formatCurrency(totalEstimatedCost)}) + Analysis ({formatCurrency(analysisCost)})
                      </p>
                    </div>
                    <p className="text-2xl font-bold text-emerald-400">
                      {formatCurrency(totalEstimatedCost + analysisCost)}
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(2)}>
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button 
                    onClick={handleCreate}
                    disabled={isCreating}
                    size="lg"
                    className="gap-2"
                  >
                    {isCreating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Start Processing
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
