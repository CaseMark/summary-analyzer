'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/components/ui/use-toast';
import {
  Plus,
  Scale,
  FileText,
  Stethoscope,
  MoreHorizontal,
  Trash2,
  Eye,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  Sparkles,
  TrendingUp,
  XCircle,
  Database,
  HardDrive,
  RefreshCw,
  CheckSquare,
  Square,
} from 'lucide-react';
import { Matter, MatterStatus, SUMMARY_TYPE_INFO } from '@/lib/types';
import { getMatters, deleteMatter } from '@/lib/storage';
import { formatRelativeTime } from '@/lib/utils';
import { deleteVault } from '@/lib/case-api';

const statusConfig: Record<
  MatterStatus,
  { label: string; color: string; icon: React.ElementType }
> = {
  created: { label: 'Created', color: 'bg-slate-500', icon: Clock },
  uploading: { label: 'Uploading', color: 'bg-blue-500', icon: Loader2 },
  processing: { label: 'Processing', color: 'bg-purple-500', icon: Loader2 },
  summarizing: { label: 'Generating', color: 'bg-amber-500', icon: Sparkles },
  analyzing: { label: 'Analyzing', color: 'bg-cyan-500', icon: TrendingUp },
  completed: { label: 'Completed', color: 'bg-emerald-500', icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', color: 'bg-amber-500', icon: XCircle },
  error: { label: 'Error', color: 'bg-red-500', icon: AlertCircle },
};

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [matters, setMatters] = useState<Matter[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; vaultId: string | null } | null>(null);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set()); // Track which items are being deleted
  const [cleanupVaults, setCleanupVaults] = useState(true);
  const [storageSize, setStorageSize] = useState<number | null>(null); // null = not yet calculated (avoids hydration mismatch)

  useEffect(() => {
    setMatters(getMatters());
    setLoading(false);
    // Calculate storage size on client only (after hydration)
    const size = new Blob([localStorage.getItem('summary-analyzer-matters') || '']).size;
    setStorageSize(size);
  }, []);

  // Refresh matters from storage
  const refreshMatters = () => {
    setMatters(getMatters());
    setSelectedIds(new Set());
    // Recalculate storage size
    const size = new Blob([localStorage.getItem('quality-checker-matters') || '']).size;
    setStorageSize(size);
  };

  // Delete single matter with optional vault cleanup
  const handleDeleteSingle = async () => {
    if (!deleteTarget) return;
    
    setDeleting(true);
    setDeletingIds(new Set([deleteTarget.id])); // Mark as deleting
    try {
      // Cleanup vault if requested and exists
      if (cleanupVaults && deleteTarget.vaultId) {
        try {
          await deleteVault(deleteTarget.vaultId);
          toast({ title: 'Vault cleaned up', description: `Vault ${deleteTarget.vaultId.substring(0, 8)}... deleted` });
        } catch (e) {
          console.error('Vault deletion failed:', e);
          toast({ 
            title: 'Vault cleanup failed', 
            description: 'The matter will be deleted but vault files may remain.',
            variant: 'destructive' 
          });
        }
      }
      
      // Delete from localStorage
      deleteMatter(deleteTarget.id);
      refreshMatters();
      toast({ title: 'Deleted', description: `"${deleteTarget.name}" has been deleted.` });
    } finally {
      setDeleting(false);
      setDeletingIds(new Set());
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    }
  };

  // Bulk delete selected matters
  const handleBulkDelete = async () => {
    setDeleting(true);
    setDeletingIds(new Set(selectedIds)); // Mark all selected as deleting
    const toDelete = matters.filter(m => selectedIds.has(m.id));
    let vaultsDeleted = 0;
    let vaultsFailed = 0;
    
    try {
      for (const matter of toDelete) {
        // Cleanup vault if requested and exists
        if (cleanupVaults && matter.vaultId) {
          try {
            await deleteVault(matter.vaultId);
            vaultsDeleted++;
          } catch {
            vaultsFailed++;
            console.error(`Failed to delete vault ${matter.vaultId}`);
          }
        }
        
        // Delete from localStorage
        deleteMatter(matter.id);
      }
      
      refreshMatters();
      
      let description = `${toDelete.length} comparison(s) deleted.`;
      if (cleanupVaults) {
        description += ` ${vaultsDeleted} vault(s) cleaned up.`;
        if (vaultsFailed > 0) {
          description += ` ${vaultsFailed} vault(s) failed to delete.`;
        }
      }
      
      toast({ title: 'Bulk Delete Complete', description });
    } finally {
      setDeleting(false);
      setDeletingIds(new Set());
      setBulkDeleteDialogOpen(false);
    }
  };

  // Toggle selection
  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Select all / none
  const toggleSelectAll = () => {
    if (selectedIds.size === matters.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(matters.map(m => m.id)));
    }
  };

  const completedMatters = matters.filter((m) => m.status === 'completed');
  const inProgressMatters = matters.filter(
    (m) => !['completed', 'error', 'created', 'cancelled'].includes(m.status)
  );
  
  const vaultsCount = matters.filter(m => m.vaultId).length;

  // Calculate aggregate stats
  const totalComparisons = completedMatters.length;
  const avgBestScore =
    completedMatters.length > 0
      ? completedMatters.reduce((sum, m) => {
          const scores = Object.values(m.qualityScores);
          const best = scores.length > 0 ? Math.max(...scores.map((s) => s.overallScore)) : 0;
          return sum + best;
        }, 0) / completedMatters.length
      : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-gradient-to-r from-card to-card/80">
        <div className="px-8 py-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-serif font-semibold tracking-tight">
                Summary Quality Checker
              </h1>
              <p className="text-muted-foreground mt-2 max-w-2xl">
                Compare AI-generated legal document summaries across multiple
                LLM models. Evaluate factual accuracy, citation precision, and
                legal utility.
              </p>
            </div>
            <Link href="/new">
              <Button variant="gold" className="gap-2">
                <Plus className="h-4 w-4" />
                New Comparison
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8 space-y-8">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Card className="bg-gradient-to-br from-card to-secondary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Runs
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{matters.length}</div>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-card to-secondary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Completed
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-emerald-400">{totalComparisons}</div>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-card to-secondary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                In Progress
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-amber-400">{inProgressMatters.length}</div>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-card to-secondary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Avg Best Score
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {avgBestScore > 0 ? Math.round(avgBestScore) : '—'}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-card to-secondary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <Database className="h-3 w-3" />
                Vaults
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-blue-400">{vaultsCount}</div>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-card to-secondary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <HardDrive className="h-3 w-3" />
                Local Storage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold">
                {storageSize === null 
                  ? '—'
                  : storageSize > 1024 * 1024 
                    ? `${(storageSize / (1024 * 1024)).toFixed(1)} MB`
                    : `${(storageSize / 1024).toFixed(1)} KB`}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Matters List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="font-serif">Your Comparisons</CardTitle>
                <CardDescription>
                  {matters.length} total runs • Click to view details • Select to bulk delete
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={refreshMatters}
                  className="gap-2"
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                {matters.length > 0 && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleSelectAll}
                      className="gap-2"
                    >
                      {selectedIds.size === matters.length ? (
                        <>
                          <CheckSquare className="h-4 w-4" />
                          Deselect All
                        </>
                      ) : (
                        <>
                          <Square className="h-4 w-4" />
                          Select All
                        </>
                      )}
                    </Button>
                    {selectedIds.size > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setBulkDeleteDialogOpen(true)}
                        className="gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete {selectedIds.size} Selected
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : matters.length === 0 ? (
              <div className="text-center py-16">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
                  <Scale className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-lg font-medium mb-2">No comparisons yet</h3>
                <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                  Create your first comparison to evaluate LLM summary quality
                  across multiple models.
                </p>
                <Link href="/new">
                  <Button variant="gold" className="gap-2">
                    <Plus className="h-4 w-4" />
                    Create Comparison
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {matters.map((matter) => {
                  const isBeingDeleted = deletingIds.has(matter.id);
                  const status = isBeingDeleted 
                    ? { label: 'Deleting...', color: 'bg-red-500', icon: Loader2 }
                    : (statusConfig[matter.status] || statusConfig.error);
                  const StatusIcon = status.icon;
                  const isProcessing = isBeingDeleted || ['uploading', 'processing', 'summarizing', 'analyzing'].includes(matter.status);
                  const isSelected = selectedIds.has(matter.id);

                  return (
                    <div
                      key={matter.id}
                      className={`group flex items-center gap-4 p-4 rounded-xl border transition-all cursor-pointer ${
                        isSelected 
                          ? 'border-primary bg-primary/5' 
                          : 'border-border bg-card hover:bg-muted/50 hover:border-primary/30'
                      }`}
                      onClick={() => router.push(`/matter/${matter.id}`)}
                    >
                      {/* Checkbox */}
                      <div 
                        className="flex-shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelection(matter.id);
                        }}
                      >
                        <Checkbox 
                          checked={isSelected}
                          className="h-5 w-5"
                        />
                      </div>

                      {/* Icon */}
                      <div className="flex-shrink-0">
                        <div className="h-12 w-12 rounded-xl bg-secondary flex items-center justify-center">
                          {SUMMARY_TYPE_INFO[matter.summaryType]?.icon === 'medical' ? (
                            <Stethoscope className="h-6 w-6 text-emerald-400" />
                          ) : (
                            <FileText className="h-6 w-6 text-blue-400" />
                          )}
                        </div>
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium truncate">{matter.name}</h3>
                          <Badge variant="outline" className="text-xs">
                            {SUMMARY_TYPE_INFO[matter.summaryType]?.label || matter.summaryType}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                          <span>
                            {matter.sourceDocuments.length} document
                            {matter.sourceDocuments.length !== 1 ? 's' : ''}
                          </span>
                          <span>•</span>
                          <span>{formatRelativeTime(matter.createdAt)}</span>
                          {matter.vaultId && (
                            <>
                              <span>•</span>
                              <span className="text-xs font-mono text-blue-400/70">
                                vault:{matter.vaultId.substring(0, 8)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Status */}
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-2 h-2 rounded-full ${status.color} ${
                              isProcessing ? 'animate-pulse' : ''
                            }`}
                          />
                          <StatusIcon
                            className={`h-4 w-4 text-muted-foreground ${
                              isProcessing ? 'animate-spin' : ''
                            }`}
                          />
                          <span className="text-sm text-muted-foreground">
                            {status.label}
                          </span>
                        </div>

                        {/* Best Score (if completed) */}
                        {matter.status === 'completed' &&
                          Object.keys(matter.qualityScores).length > 0 && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                              <span className="text-sm font-medium text-emerald-400">
                                {Math.round(Math.max(
                                  ...Object.values(matter.qualityScores).map(
                                    (s) => s.overallScore
                                  )
                                ))}
                              </span>
                              <span className="text-xs text-emerald-400/70">
                                best
                              </span>
                            </div>
                          )}

                        {/* Actions */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/matter/${matter.id}`);
                              }}
                            >
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-red-400"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget({ id: matter.id, name: matter.name, vaultId: matter.vaultId });
                                setDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>

                        <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Single Delete Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Comparison</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          {deleteTarget?.vaultId && (
            <div className="flex items-center space-x-2 p-3 rounded-lg bg-muted">
              <Checkbox 
                id="cleanup-vault" 
                checked={cleanupVaults}
                onCheckedChange={(checked) => setCleanupVaults(checked as boolean)}
              />
              <label htmlFor="cleanup-vault" className="text-sm cursor-pointer">
                Also delete vault files ({deleteTarget.vaultId.substring(0, 8)}...)
              </label>
            </div>
          )}
          
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteSingle}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Dialog */}
      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Comparisons</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedIds.size} selected comparison(s)? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="space-y-3">
            {/* Summary of what will be deleted */}
            <div className="p-3 rounded-lg bg-muted text-sm">
              <div className="flex justify-between">
                <span>Comparisons to delete:</span>
                <span className="font-medium">{selectedIds.size}</span>
              </div>
              <div className="flex justify-between">
                <span>Vaults to cleanup:</span>
                <span className="font-medium">
                  {matters.filter(m => selectedIds.has(m.id) && m.vaultId).length}
                </span>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox 
                id="cleanup-vaults-bulk" 
                checked={cleanupVaults}
                onCheckedChange={(checked) => setCleanupVaults(checked as boolean)}
              />
              <label htmlFor="cleanup-vaults-bulk" className="text-sm cursor-pointer">
                Also delete vault files to free up storage
              </label>
            </div>
          </div>
          
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleBulkDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                `Delete ${selectedIds.size} Items`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


