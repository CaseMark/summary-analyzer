'use client';

import { useEffect, useState } from 'react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Trophy,
  DollarSign,
  Target,
  Zap,
  BarChart3,
  FileText,
  Minus,
  Crown,
  Medal,
  Award,
  Sparkles,
  Scale,
  Stethoscope,
  FileStack,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import { Matter, TEST_MODELS, ModelConfig, SummaryType, SUMMARY_TYPE_INFO } from '@/lib/types';
import { getMatters } from '@/lib/storage';
import { cn, formatCurrency, getScoreColor } from '@/lib/utils';

interface ModelStats {
  model: ModelConfig;
  runCount: number;
  avgScore: number;
  avgScoreVsBaseline: number;
  totalCost: number;
  avgCost: number;
  avgCostVsBaseline: number;
  winCount: number;
  podiumCount: number;
  avgRank: number;
  scores: number[];
  qualityCostRatio: number;
  // New: Store individual run details for reasoning
  bestScore: number;
  worstScore: number;
  avgFactualAccuracy: number;
  avgCitationAccuracy: number;
  avgRelevance: number;
  avgComprehensiveness: number;
  avgLegalUtility: number;
}

interface SummaryTypeAnalytics {
  summaryType: SummaryType;
  label: string;
  runCount: number;
  modelStats: Record<string, ModelStats>;
  recommendation: {
    bestQuality: string | null;
    bestValue: string | null;
    recommendedSwitch: string | null;
    reasoning: string;
  };
}

interface AggregateAnalytics {
  totalRuns: number;
  completedRuns: number;
  totalDocuments: number;
  // Overall stats (all types combined)
  overallStats: {
    modelStats: Record<string, ModelStats>;
    recommendation: {
      bestQuality: string | null;
      bestValue: string | null;
      recommendedSwitch: string | null;
      reasoning: string;
    };
  };
  // Per-summary-type stats
  byType: Record<string, SummaryTypeAnalytics>;
  baselineModelId: string;
}

const BASELINE_MODEL_ID = 'google/gemini-2.5-flash';

function initializeModelStats(model: ModelConfig): ModelStats {
  return {
    model,
    runCount: 0,
    avgScore: 0,
    avgScoreVsBaseline: 0,
    totalCost: 0,
    avgCost: 0,
    avgCostVsBaseline: 0,
    winCount: 0,
    podiumCount: 0,
    avgRank: 0,
    scores: [],
    qualityCostRatio: 0,
    bestScore: 0,
    worstScore: 100,
    avgFactualAccuracy: 0,
    avgCitationAccuracy: 0,
    avgRelevance: 0,
    avgComprehensiveness: 0,
    avgLegalUtility: 0,
  };
}

function aggregateModelStats(
  modelStats: Record<string, ModelStats>,
  matter: Matter,
  baselineModelId: string
): void {
  const scores = Object.values(matter.qualityScores);
  const baselineScore = matter.qualityScores[baselineModelId];
  const ranked = [...scores].sort((a, b) => b.overallScore - a.overallScore);

  scores.forEach((score) => {
    const stats = modelStats[score.model];
    if (!stats) return;

    const summary = matter.summaries[score.model];
    const rank = ranked.findIndex((r) => r.model === score.model) + 1;

    stats.runCount++;
    stats.scores.push(score.overallScore);
    stats.totalCost += summary?.costUsd || 0;
    stats.avgRank = (stats.avgRank * (stats.runCount - 1) + rank) / stats.runCount;

    // Track best/worst
    if (score.overallScore > stats.bestScore) stats.bestScore = score.overallScore;
    if (score.overallScore < stats.worstScore) stats.worstScore = score.overallScore;

    // Track category averages
    const n = stats.runCount;
    stats.avgFactualAccuracy = ((stats.avgFactualAccuracy * (n - 1)) + (score.factualAccuracy?.score || 0)) / n;
    stats.avgCitationAccuracy = ((stats.avgCitationAccuracy * (n - 1)) + (score.citationAccuracy?.score || 0)) / n;
    stats.avgRelevance = ((stats.avgRelevance * (n - 1)) + (score.relevance?.score || 0)) / n;
    stats.avgComprehensiveness = ((stats.avgComprehensiveness * (n - 1)) + (score.comprehensiveness?.score || 0)) / n;
    stats.avgLegalUtility = ((stats.avgLegalUtility * (n - 1)) + (score.legalUtility?.score || 0)) / n;

    if (rank === 1) stats.winCount++;
    if (rank <= 3) stats.podiumCount++;

    if (baselineScore) {
      stats.avgScoreVsBaseline =
        (stats.avgScoreVsBaseline * (stats.runCount - 1) +
          (score.overallScore - baselineScore.overallScore)) /
        stats.runCount;
    }
  });
}

function finalizeModelStats(modelStats: Record<string, ModelStats>, baselineModelId: string): void {
  Object.values(modelStats).forEach((stats) => {
    if (stats.runCount > 0) {
      stats.avgScore = stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length;
      stats.avgCost = stats.totalCost / stats.runCount;

      const baselineStats = modelStats[baselineModelId];
      if (baselineStats && baselineStats.avgCost > 0) {
        stats.avgCostVsBaseline =
          ((baselineStats.avgCost - stats.avgCost) / baselineStats.avgCost) * 100;
      }

      stats.qualityCostRatio = stats.avgCost > 0 ? stats.avgScore / stats.avgCost : 0;
    }
  });
}

function generateRecommendation(
  modelStats: Record<string, ModelStats>,
  baselineModelId: string
): { bestQuality: string | null; bestValue: string | null; recommendedSwitch: string | null; reasoning: string } {
  const validStats = Object.values(modelStats).filter((s) => s.runCount > 0);
  const baselineStats = modelStats[baselineModelId];

  let bestQuality: string | null = null;
  let bestValue: string | null = null;
  let recommendedSwitch: string | null = null;
  let reasoning = '';

  if (validStats.length > 0) {
    const byQuality = [...validStats].sort((a, b) => b.avgScore - a.avgScore);
    bestQuality = byQuality[0]?.model.id || null;

    const byValue = [...validStats].sort((a, b) => b.qualityCostRatio - a.qualityCostRatio);
    bestValue = byValue[0]?.model.id || null;

    if (baselineStats && baselineStats.runCount > 0) {
      const candidates = validStats
        .filter(
          (s) =>
            s.model.id !== baselineModelId &&
            s.avgCostVsBaseline > 10 &&
            s.avgScoreVsBaseline > -5 // Allow up to 5 point quality drop
        )
        .sort((a, b) => b.avgCostVsBaseline - a.avgCostVsBaseline);

      if (candidates.length > 0) {
        recommendedSwitch = candidates[0].model.id;
        const switchStats = candidates[0];
        reasoning = `${switchStats.model.name} offers ${switchStats.avgCostVsBaseline.toFixed(0)}% cost savings with only ${Math.abs(switchStats.avgScoreVsBaseline).toFixed(1)} point quality difference from baseline.`;
      } else {
        const betterModels = validStats.filter(
          (s) => s.model.id !== baselineModelId && s.avgScoreVsBaseline > 3
        );
        if (betterModels.length > 0) {
          const best = betterModels.sort((a, b) => b.avgScoreVsBaseline - a.avgScoreVsBaseline)[0];
          reasoning = `${best.model.name} shows +${best.avgScoreVsBaseline.toFixed(1)} better quality than baseline. Consider upgrading despite ${best.avgCostVsBaseline > 0 ? 'similar' : 'higher'} cost.`;
        } else {
          reasoning = 'Current baseline remains competitive. More data needed for confident recommendations.';
        }
      }
    }
  }

  return { bestQuality, bestValue, recommendedSwitch, reasoning };
}

function generateModelReasoning(stats: ModelStats, baselineStats: ModelStats | null, rank: number): string {
  const reasons: string[] = [];
  
  // Quality assessment
  if (stats.avgScore >= 80) {
    reasons.push('Excellent overall quality');
  } else if (stats.avgScore >= 65) {
    reasons.push('Good quality scores');
  } else if (stats.avgScore >= 50) {
    reasons.push('Moderate quality');
  } else {
    reasons.push('Quality needs improvement');
  }
  
  // Consistency
  const scoreRange = stats.bestScore - stats.worstScore;
  if (scoreRange < 10) {
    reasons.push('highly consistent results');
  } else if (scoreRange > 25) {
    reasons.push('inconsistent performance');
  }
  
  // Cost comparison
  if (baselineStats && baselineStats.runCount > 0) {
    if (stats.avgCostVsBaseline > 70) {
      reasons.push(`${stats.avgCostVsBaseline.toFixed(0)}% cheaper than baseline`);
    } else if (stats.avgCostVsBaseline > 30) {
      reasons.push('significantly lower cost');
    } else if (stats.avgCostVsBaseline < -20) {
      reasons.push('higher cost than baseline');
    }
  }
  
  // Category strengths
  const categories = [
    { name: 'factual accuracy', score: stats.avgFactualAccuracy },
    { name: 'citations', score: stats.avgCitationAccuracy },
    { name: 'relevance', score: stats.avgRelevance },
    { name: 'comprehensiveness', score: stats.avgComprehensiveness },
    { name: 'legal utility', score: stats.avgLegalUtility },
  ].filter(c => c.score > 0);
  
  const strengths = categories.filter(c => c.score >= 75).map(c => c.name);
  const weaknesses = categories.filter(c => c.score < 50).map(c => c.name);
  
  if (strengths.length > 0) {
    reasons.push(`strong ${strengths.slice(0, 2).join(' & ')}`);
  }
  if (weaknesses.length > 0) {
    reasons.push(`weak ${weaknesses.slice(0, 1).join(' & ')}`);
  }
  
  // Value proposition
  if (stats.qualityCostRatio > 10000) {
    reasons.push('exceptional value');
  } else if (stats.qualityCostRatio > 5000) {
    reasons.push('good value proposition');
  }
  
  return reasons.slice(0, 3).join(' • ');
}

function calculateAnalytics(matters: Matter[]): AggregateAnalytics {
  const completedMatters = matters.filter(
    (m) => m.status === 'completed' && Object.keys(m.qualityScores).length > 0
  );

  // Initialize overall stats
  const overallModelStats: Record<string, ModelStats> = {};
  TEST_MODELS.forEach((model) => {
    overallModelStats[model.id] = initializeModelStats(model);
  });

  // Initialize per-type stats
  const byType: Record<string, SummaryTypeAnalytics> = {};

  // Process each completed matter
  completedMatters.forEach((matter) => {
    const summaryType = matter.summaryType;
    
    // Initialize type analytics if not exists
    if (!byType[summaryType]) {
      const typeModelStats: Record<string, ModelStats> = {};
      TEST_MODELS.forEach((model) => {
        typeModelStats[model.id] = initializeModelStats(model);
      });
      
      byType[summaryType] = {
        summaryType,
        label: SUMMARY_TYPE_INFO[summaryType]?.label || summaryType,
        runCount: 0,
        modelStats: typeModelStats,
        recommendation: { bestQuality: null, bestValue: null, recommendedSwitch: null, reasoning: '' },
      };
    }
    
    byType[summaryType].runCount++;
    
    // Aggregate to overall stats
    aggregateModelStats(overallModelStats, matter, BASELINE_MODEL_ID);
    
    // Aggregate to type-specific stats
    aggregateModelStats(byType[summaryType].modelStats, matter, BASELINE_MODEL_ID);
  });

  // Finalize overall stats
  finalizeModelStats(overallModelStats, BASELINE_MODEL_ID);
  
  // Finalize per-type stats
  Object.values(byType).forEach((typeStats) => {
    finalizeModelStats(typeStats.modelStats, BASELINE_MODEL_ID);
    typeStats.recommendation = generateRecommendation(typeStats.modelStats, BASELINE_MODEL_ID);
  });

  return {
    totalRuns: matters.length,
    completedRuns: completedMatters.length,
    totalDocuments: matters.reduce((sum, m) => sum + m.sourceDocuments.length, 0),
    overallStats: {
      modelStats: overallModelStats,
      recommendation: generateRecommendation(overallModelStats, BASELINE_MODEL_ID),
    },
    byType,
    baselineModelId: BASELINE_MODEL_ID,
  };
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  color = 'primary',
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  trend?: 'up' | 'down' | 'neutral';
  color?: 'primary' | 'emerald' | 'amber' | 'red';
}) {
  const colorClasses = {
    primary: 'text-primary',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className={cn('text-2xl font-bold', colorClasses[color])}>{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {trend && (
              <div
                className={cn(
                  'p-1 rounded',
                  trend === 'up' && 'bg-emerald-500/10 text-emerald-400',
                  trend === 'down' && 'bg-red-500/10 text-red-400',
                  trend === 'neutral' && 'bg-muted text-muted-foreground'
                )}
              >
                {trend === 'up' ? (
                  <TrendingUp className="h-4 w-4" />
                ) : trend === 'down' ? (
                  <TrendingDown className="h-4 w-4" />
                ) : (
                  <Minus className="h-4 w-4" />
                )}
              </div>
            )}
            <Icon className={cn('h-8 w-8', colorClasses[color], 'opacity-50')} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryTypeIcon({ type }: { type: string }) {
  const info = SUMMARY_TYPE_INFO[type as SummaryType];
  if (!info) return <FileStack className="h-4 w-4" />;
  
  switch (info.icon) {
    case 'deposition': return <Scale className="h-4 w-4" />;
    case 'medical': return <Stethoscope className="h-4 w-4" />;
    default: return <FileStack className="h-4 w-4" />;
  }
}

function ModelLeaderboard({ 
  modelStats, 
  baselineModelId,
  title = "Model Leaderboard",
  description = "Ranked by average quality score"
}: { 
  modelStats: Record<string, ModelStats>; 
  baselineModelId: string;
  title?: string;
  description?: string;
}) {
  const sortedModels = Object.values(modelStats)
    .filter((s) => s.runCount > 0)
    .sort((a, b) => b.avgScore - a.avgScore);
  
  const baselineStats = modelStats[baselineModelId];

  if (sortedModels.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          No data available for this summary type yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif flex items-center gap-2">
          <Trophy className="h-5 w-5 text-primary" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {sortedModels.map((stats, index) => {
            const isBaseline = stats.model.id === baselineModelId;
            const RankIcon = index === 0 ? Crown : index === 1 ? Medal : index === 2 ? Award : null;
            const reasoning = generateModelReasoning(stats, baselineStats, index);

            return (
              <div
                key={stats.model.id}
                className={cn(
                  'p-4 rounded-lg border transition-colors',
                  isBaseline && 'border-primary/30 bg-primary/5',
                  index === 0 && !isBaseline && 'border-emerald-500/30 bg-emerald-500/5'
                )}
              >
                <div className="flex items-center gap-4">
                  {/* Rank */}
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted shrink-0">
                    {RankIcon ? (
                      <RankIcon
                        className={cn(
                          'h-4 w-4',
                          index === 0 && 'text-amber-400',
                          index === 1 && 'text-zinc-400',
                          index === 2 && 'text-amber-600'
                        )}
                      />
                    ) : (
                      <span className="text-sm font-medium">{index + 1}</span>
                    )}
                  </div>

                  {/* Model Info */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: stats.model.color }}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium">{stats.model.name}</p>
                        {isBaseline && (
                          <Badge variant="outline" className="text-xs">
                            BASELINE
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {stats.model.provider} • {stats.runCount} runs
                      </p>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-4 gap-6 text-right shrink-0">
                    <div>
                      <p className={cn('text-lg font-bold', getScoreColor(stats.avgScore))}>
                        {stats.avgScore.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">avg score</p>
                    </div>
                    <div>
                      <p
                        className={cn(
                          'text-lg font-bold',
                          stats.avgScoreVsBaseline > 0
                            ? 'text-emerald-400'
                            : stats.avgScoreVsBaseline < -3
                            ? 'text-red-400'
                            : 'text-muted-foreground'
                        )}
                      >
                        {stats.avgScoreVsBaseline >= 0 ? '+' : ''}
                        {stats.avgScoreVsBaseline.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">vs baseline</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold">{formatCurrency(stats.avgCost)}</p>
                      <p className="text-xs text-muted-foreground">avg cost</p>
                    </div>
                    <div>
                      <p
                        className={cn(
                          'text-lg font-bold',
                          stats.avgCostVsBaseline > 20
                            ? 'text-emerald-400'
                            : stats.avgCostVsBaseline < 0
                            ? 'text-red-400'
                            : 'text-muted-foreground'
                        )}
                      >
                        {stats.avgCostVsBaseline >= 0 ? '-' : '+'}
                        {Math.abs(stats.avgCostVsBaseline).toFixed(0)}%
                      </p>
                      <p className="text-xs text-muted-foreground">cost savings</p>
                    </div>
                  </div>
                </div>

                {/* Model Reasoning - NEW */}
                <div className="mt-3 pt-3 border-t border-border/50">
                  <div className="flex items-start gap-2 text-sm">
                    <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-muted-foreground">{reasoning}</p>
                  </div>
                </div>

                {/* Win/Podium Stats */}
                <div className="mt-2 pt-2 flex items-center gap-6 text-sm flex-wrap">
                  <div className="flex items-center gap-1">
                    <Crown className="h-3 w-3 text-amber-400" />
                    <span className="text-muted-foreground">
                      {stats.winCount} wins ({((stats.winCount / stats.runCount) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Medal className="h-3 w-3 text-zinc-400" />
                    <span className="text-muted-foreground">
                      {stats.podiumCount} podiums ({((stats.podiumCount / stats.runCount) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <BarChart3 className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Avg rank: {stats.avgRank.toFixed(1)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <DollarSign className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {stats.qualityCostRatio.toFixed(0)} score/$
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function RecommendationCard({ 
  recommendation, 
  modelStats 
}: { 
  recommendation: { bestQuality: string | null; bestValue: string | null; recommendedSwitch: string | null; reasoning: string };
  modelStats: Record<string, ModelStats>;
}) {
  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10">
      <CardHeader>
        <CardTitle className="font-serif flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Recommendation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground">{recommendation.reasoning}</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {recommendation.bestQuality && modelStats[recommendation.bestQuality] && (
            <div className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
              <div className="flex items-center gap-2 mb-2">
                <Crown className="h-4 w-4 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-400">Best Quality</span>
              </div>
              <p className="font-bold">
                {modelStats[recommendation.bestQuality]?.model.name}
              </p>
              <p className="text-sm text-muted-foreground">
                Avg score: {modelStats[recommendation.bestQuality]?.avgScore.toFixed(2)}
              </p>
            </div>
          )}

          {recommendation.bestValue && modelStats[recommendation.bestValue] && (
            <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-medium text-amber-400">Best Value</span>
              </div>
              <p className="font-bold">
                {modelStats[recommendation.bestValue]?.model.name}
              </p>
              <p className="text-sm text-muted-foreground">
                {modelStats[recommendation.bestValue]?.qualityCostRatio.toFixed(0)} score/$
              </p>
            </div>
          )}

          {recommendation.recommendedSwitch && modelStats[recommendation.recommendedSwitch] && (
            <div className="p-4 rounded-lg border-2 border-primary/50 bg-primary/10">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium text-primary">Recommended Switch</span>
              </div>
              <p className="font-bold">
                {modelStats[recommendation.recommendedSwitch]?.model.name}
              </p>
              <p className="text-sm text-muted-foreground">
                {modelStats[recommendation.recommendedSwitch]?.avgCostVsBaseline.toFixed(0)}% cheaper
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<AggregateAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedType, setSelectedType] = useState<string>('all');

  useEffect(() => {
    const matters = getMatters();
    const stats = calculateAnalytics(matters);
    setAnalytics(stats);
    setLoading(false);
  }, []);

  if (loading || !analytics) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-muted-foreground">Loading analytics...</div>
      </div>
    );
  }

  const baselineStats = analytics.overallStats.modelStats[BASELINE_MODEL_ID];
  const summaryTypes = Object.keys(analytics.byType);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-gradient-to-r from-card to-card/80">
        <div className="px-8 py-6">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-serif font-semibold tracking-tight">
                Cross-Run Analytics
              </h1>
              <p className="text-muted-foreground mt-1">
                Aggregate trends across {analytics.completedRuns} completed comparisons
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8 space-y-8">
        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            title="Completed Runs"
            value={analytics.completedRuns}
            subtitle={`of ${analytics.totalRuns} total`}
            icon={BarChart3}
            color="primary"
          />
          <StatCard
            title="Documents Analyzed"
            value={analytics.totalDocuments}
            icon={FileText}
            color="primary"
          />
          <StatCard
            title="Models Tested"
            value={TEST_MODELS.length}
            icon={Target}
            color="primary"
          />
          <StatCard
            title="Baseline Score"
            value={baselineStats && baselineStats.runCount > 0 ? Math.round(baselineStats.avgScore) : 'N/A'}
            subtitle="Gemini 2.5 Flash avg"
            icon={Trophy}
            color="emerald"
          />
        </div>

        {analytics.completedRuns === 0 ? (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="pt-6 text-center">
              <BarChart3 className="h-12 w-12 text-amber-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No Completed Comparisons Yet</h3>
              <p className="text-muted-foreground mb-4">
                Run some comparisons to see aggregate analytics and trends.
              </p>
              <Link href="/new">
                <Button variant="gold">Start First Comparison</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Summary Type Tabs */}
            <Tabs value={selectedType} onValueChange={setSelectedType} className="space-y-6">
              <div className="flex items-center justify-between">
                <TabsList className="bg-muted/50">
                  <TabsTrigger value="all" className="gap-2">
                    <FileStack className="h-4 w-4" />
                    All Types
                  </TabsTrigger>
                  {summaryTypes.map((type) => (
                    <TabsTrigger key={type} value={type} className="gap-2">
                      <SummaryTypeIcon type={type} />
                      {analytics.byType[type].label}
                      <Badge variant="secondary" className="ml-1 text-xs">
                        {analytics.byType[type].runCount}
                      </Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              {/* All Types Tab */}
              <TabsContent value="all" className="space-y-6">
                <RecommendationCard 
                  recommendation={analytics.overallStats.recommendation}
                  modelStats={analytics.overallStats.modelStats}
                />
                <ModelLeaderboard 
                  modelStats={analytics.overallStats.modelStats}
                  baselineModelId={analytics.baselineModelId}
                  title="Overall Model Leaderboard"
                  description="Ranked by average quality score across all summary types"
                />
              </TabsContent>

              {/* Per-Type Tabs */}
              {summaryTypes.map((type) => (
                <TabsContent key={type} value={type} className="space-y-6">
                  <Card className="border-muted">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                          <SummaryTypeIcon type={type} />
                        </div>
                        <div>
                          <CardTitle className="text-lg">{analytics.byType[type].label}</CardTitle>
                          <CardDescription>
                            {analytics.byType[type].runCount} comparison{analytics.byType[type].runCount !== 1 ? 's' : ''} analyzed
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                  
                  <RecommendationCard 
                    recommendation={analytics.byType[type].recommendation}
                    modelStats={analytics.byType[type].modelStats}
                  />
                  
                  <ModelLeaderboard 
                    modelStats={analytics.byType[type].modelStats}
                    baselineModelId={analytics.baselineModelId}
                    title={`${analytics.byType[type].label} Leaderboard`}
                    description={`Model performance for ${analytics.byType[type].label.toLowerCase()} summaries`}
                  />
                </TabsContent>
              ))}
            </Tabs>

            {/* Score Consistency - Overall only */}
            {selectedType === 'all' && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-serif flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-primary" />
                    Score Consistency
                  </CardTitle>
                  <CardDescription>
                    Score range and variance across runs (wider = less consistent)
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {Object.values(analytics.overallStats.modelStats)
                      .filter((s) => s.runCount > 0)
                      .sort((a, b) => b.avgScore - a.avgScore)
                      .map((stats) => {
                        const min = Math.min(...stats.scores);
                        const max = Math.max(...stats.scores);
                        const minPos = Math.max(0, ((min - 30) / 70) * 100);
                        const maxPos = Math.min(100, ((max - 30) / 70) * 100);

                        return (
                          <div key={stats.model.id} className="flex items-center gap-4">
                            <div className="w-40 flex items-center gap-2">
                              <div
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: stats.model.color }}
                              />
                              <span className="text-sm truncate">{stats.model.name}</span>
                            </div>
                            <div className="flex-1 h-6 bg-muted rounded relative">
                              <div
                                className="absolute h-full rounded"
                                style={{
                                  left: `${minPos}%`,
                                  width: `${Math.max(2, maxPos - minPos)}%`,
                                  backgroundColor: stats.model.color,
                                  opacity: 0.3,
                                }}
                              />
                              <div
                                className="absolute top-0 bottom-0 w-1 rounded"
                                style={{
                                  left: `${Math.max(0, Math.min(100, ((stats.avgScore - 30) / 70) * 100))}%`,
                                  backgroundColor: stats.model.color,
                                }}
                              />
                            </div>
                            <div className="w-24 text-right">
                              <span className="text-sm font-mono">
                                {Math.round(min)} - {Math.round(max)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground mt-2 px-44">
                    <span>30</span>
                    <span>50</span>
                    <span>70</span>
                    <span>90</span>
                    <span>100</span>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
