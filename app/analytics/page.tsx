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
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
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
  CheckCircle2,
  Minus,
  Crown,
  Medal,
  Award,
} from 'lucide-react';
import { Matter, TEST_MODELS, ModelConfig } from '@/lib/types';
import { getMatters } from '@/lib/storage';
import { cn, formatCurrency, getScoreColor } from '@/lib/utils';

interface ModelStats {
  model: ModelConfig;
  runCount: number;
  avgScore: number;
  avgScoreVsBaseline: number; // delta from baseline
  totalCost: number;
  avgCost: number;
  avgCostVsBaseline: number; // % savings vs baseline
  winCount: number; // times ranked #1
  podiumCount: number; // times ranked #1-3
  avgRank: number;
  scores: number[]; // all individual scores for variance
  qualityCostRatio: number; // score per dollar
}

interface AggregateAnalytics {
  totalRuns: number;
  completedRuns: number;
  totalDocuments: number;
  modelStats: Record<string, ModelStats>;
  baselineModelId: string;
  recommendation: {
    bestQuality: string | null;
    bestValue: string | null;
    recommendedSwitch: string | null;
    reasoning: string;
  };
}

const BASELINE_MODEL_ID = 'google/gemini-2.5-flash';

function calculateAnalytics(matters: Matter[]): AggregateAnalytics {
  const completedMatters = matters.filter(
    (m) => m.status === 'completed' && Object.keys(m.qualityScores).length > 0
  );

  // Initialize stats for each model
  const modelStats: Record<string, ModelStats> = {};
  TEST_MODELS.forEach((model) => {
    modelStats[model.id] = {
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
    };
  });

  // Aggregate data from each completed matter
  completedMatters.forEach((matter) => {
    const scores = Object.values(matter.qualityScores);
    const baselineScore = matter.qualityScores[BASELINE_MODEL_ID];
    
    // Sort by score to determine rankings
    const ranked = [...scores].sort((a, b) => b.overallScore - a.overallScore);

    scores.forEach((score) => {
      const stats = modelStats[score.model];
      if (!stats) return; // Skip if model not in current TEST_MODELS

      const summary = matter.summaries[score.model];
      const rank = ranked.findIndex((r) => r.model === score.model) + 1;

      stats.runCount++;
      stats.scores.push(score.overallScore);
      stats.totalCost += summary?.costUsd || 0;
      stats.avgRank = (stats.avgRank * (stats.runCount - 1) + rank) / stats.runCount;

      if (rank === 1) stats.winCount++;
      if (rank <= 3) stats.podiumCount++;

      // Calculate delta vs baseline
      if (baselineScore) {
        stats.avgScoreVsBaseline =
          (stats.avgScoreVsBaseline * (stats.runCount - 1) +
            (score.overallScore - baselineScore.overallScore)) /
          stats.runCount;
      }
    });
  });

  // Calculate averages
  Object.values(modelStats).forEach((stats) => {
    if (stats.runCount > 0) {
      stats.avgScore = stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length;
      stats.avgCost = stats.totalCost / stats.runCount;

      const baselineStats = modelStats[BASELINE_MODEL_ID];
      if (baselineStats && baselineStats.avgCost > 0) {
        stats.avgCostVsBaseline =
          ((baselineStats.avgCost - stats.avgCost) / baselineStats.avgCost) * 100;
      }

      stats.qualityCostRatio = stats.avgCost > 0 ? stats.avgScore / stats.avgCost : 0;
    }
  });

  // Generate recommendations
  const validStats = Object.values(modelStats).filter((s) => s.runCount > 0);
  const baselineStats = modelStats[BASELINE_MODEL_ID];

  let bestQuality: string | null = null;
  let bestValue: string | null = null;
  let recommendedSwitch: string | null = null;
  let reasoning = '';

  if (validStats.length > 0) {
    // Best quality = highest average score
    const byQuality = [...validStats].sort((a, b) => b.avgScore - a.avgScore);
    bestQuality = byQuality[0]?.model.id || null;

    // Best value = highest quality:cost ratio
    const byValue = [...validStats].sort((a, b) => b.qualityCostRatio - a.qualityCostRatio);
    bestValue = byValue[0]?.model.id || null;

    // Recommended switch = cheaper than baseline with quality within 0.5 points
    if (baselineStats && baselineStats.runCount > 0) {
      const candidates = validStats
        .filter(
          (s) =>
            s.model.id !== BASELINE_MODEL_ID &&
            s.avgCostVsBaseline > 10 && // At least 10% cheaper
            s.avgScoreVsBaseline > -0.5 // Quality within 0.5 of baseline
        )
        .sort((a, b) => b.avgCostVsBaseline - a.avgCostVsBaseline); // Most savings first

      if (candidates.length > 0) {
        recommendedSwitch = candidates[0].model.id;
        const switchStats = candidates[0];
        reasoning = `${switchStats.model.name} offers ${switchStats.avgCostVsBaseline.toFixed(0)}% cost savings with only ${Math.abs(switchStats.avgScoreVsBaseline).toFixed(2)} point quality difference from baseline.`;
      } else {
        // Check if any model is significantly better
        const betterModels = validStats.filter(
          (s) => s.model.id !== BASELINE_MODEL_ID && s.avgScoreVsBaseline > 0.3
        );
        if (betterModels.length > 0) {
          const best = betterModels.sort((a, b) => b.avgScoreVsBaseline - a.avgScoreVsBaseline)[0];
          reasoning = `${best.model.name} shows +${best.avgScoreVsBaseline.toFixed(2)} better quality than baseline. Consider upgrading despite ${best.avgCostVsBaseline > 0 ? 'similar' : 'higher'} cost.`;
        } else {
          reasoning = 'Current baseline (Gemini 2.5 Flash) remains the best balance of quality and cost. More data needed for confident recommendations.';
        }
      }
    }
  }

  return {
    totalRuns: matters.length,
    completedRuns: completedMatters.length,
    totalDocuments: matters.reduce((sum, m) => sum + m.sourceDocuments.length, 0),
    modelStats,
    baselineModelId: BASELINE_MODEL_ID,
    recommendation: {
      bestQuality,
      bestValue,
      recommendedSwitch,
      reasoning,
    },
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

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<AggregateAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

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

  const sortedModels = Object.values(analytics.modelStats)
    .filter((s) => s.runCount > 0)
    .sort((a, b) => b.avgScore - a.avgScore);

  const baselineStats = analytics.modelStats[BASELINE_MODEL_ID];

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
            value={baselineStats ? Math.round(baselineStats.avgScore) : 'N/A'}
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
            {/* Recommendation Card */}
            <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10">
              <CardHeader>
                <CardTitle className="font-serif flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  Recommendation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">{analytics.recommendation.reasoning}</p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {analytics.recommendation.bestQuality && (
                    <div className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
                      <div className="flex items-center gap-2 mb-2">
                        <Crown className="h-4 w-4 text-emerald-400" />
                        <span className="text-sm font-medium text-emerald-400">Best Quality</span>
                      </div>
                      <p className="font-bold">
                        {analytics.modelStats[analytics.recommendation.bestQuality]?.model.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Avg score:{' '}
                        {analytics.modelStats[analytics.recommendation.bestQuality]?.avgScore.toFixed(
                          2
                        )}
                      </p>
                    </div>
                  )}

                  {analytics.recommendation.bestValue && (
                    <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
                      <div className="flex items-center gap-2 mb-2">
                        <DollarSign className="h-4 w-4 text-amber-400" />
                        <span className="text-sm font-medium text-amber-400">Best Value</span>
                      </div>
                      <p className="font-bold">
                        {analytics.modelStats[analytics.recommendation.bestValue]?.model.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {analytics.modelStats[
                          analytics.recommendation.bestValue
                        ]?.qualityCostRatio.toFixed(0)}{' '}
                        score/$
                      </p>
                    </div>
                  )}

                  {analytics.recommendation.recommendedSwitch && (
                    <div className="p-4 rounded-lg border-2 border-primary/50 bg-primary/10">
                      <div className="flex items-center gap-2 mb-2">
                        <Target className="h-4 w-4 text-primary" />
                        <span className="text-sm font-medium text-primary">Recommended Switch</span>
                      </div>
                      <p className="font-bold">
                        {analytics.modelStats[analytics.recommendation.recommendedSwitch]?.model.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {analytics.modelStats[
                          analytics.recommendation.recommendedSwitch
                        ]?.avgCostVsBaseline.toFixed(0)}
                        % cheaper
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Model Leaderboard */}
            <Card>
              <CardHeader>
                <CardTitle className="font-serif flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-primary" />
                  Model Leaderboard
                </CardTitle>
                <CardDescription>
                  Ranked by average quality score across all runs
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {sortedModels.map((stats, index) => {
                    const isBaseline = stats.model.id === BASELINE_MODEL_ID;
                    const RankIcon = index === 0 ? Crown : index === 1 ? Medal : index === 2 ? Award : null;

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
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted">
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
                          <div className="flex items-center gap-3 flex-1">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: stats.model.color }}
                            />
                            <div>
                              <div className="flex items-center gap-2">
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
                          <div className="grid grid-cols-4 gap-6 text-right">
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
                                    : stats.avgScoreVsBaseline < -0.3
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

                        {/* Win/Podium Stats */}
                        <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-6 text-sm">
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

            {/* Score Distribution */}
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
                  {sortedModels.map((stats) => {
                    const min = Math.min(...stats.scores);
                    const max = Math.max(...stats.scores);
                    const range = max - min;
                    const minPos = ((min - 5) / 5) * 100; // Assuming 5-10 score range
                    const maxPos = ((max - 5) / 5) * 100;

                    return (
                      <div key={stats.model.id} className="flex items-center gap-4">
                        <div className="w-40 flex items-center gap-2">
                          <div
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: stats.model.color }}
                          />
                          <span className="text-sm truncate">{stats.model.name}</span>
                        </div>
                        <div className="flex-1 h-6 bg-muted rounded relative">
                          {/* Score range bar */}
                          <div
                            className="absolute h-full rounded"
                            style={{
                              left: `${minPos}%`,
                              width: `${maxPos - minPos}%`,
                              backgroundColor: stats.model.color,
                              opacity: 0.3,
                            }}
                          />
                          {/* Average marker */}
                          <div
                            className="absolute top-0 bottom-0 w-1 rounded"
                            style={{
                              left: `${((stats.avgScore - 50) / 50) * 100}%`,
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
                  <span>50</span>
                  <span>6.0</span>
                  <span>7.0</span>
                  <span>8.0</span>
                  <span>9.0</span>
                  <span>100</span>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

