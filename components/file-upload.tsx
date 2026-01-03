'use client';

import { useCallback, useState } from 'react';
import { Upload, FileText, X, Loader2 } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface FileUploadProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  maxFiles?: number;
  acceptedTypes?: string[];
  disabled?: boolean;
}

export function FileUpload({
  files,
  onFilesChange,
  maxFiles = 10,
  acceptedTypes = ['.pdf', '.txt', '.docx'],
  disabled = false,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDragging(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (disabled) return;

      const droppedFiles = Array.from(e.dataTransfer.files).filter((file) => {
        const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;
        return acceptedTypes.includes(ext);
      });

      const newFiles = [...files, ...droppedFiles].slice(0, maxFiles);
      onFilesChange(newFiles);
    },
    [files, onFilesChange, maxFiles, acceptedTypes, disabled]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled || !e.target.files) return;

      const selectedFiles = Array.from(e.target.files);
      const newFiles = [...files, ...selectedFiles].slice(0, maxFiles);
      onFilesChange(newFiles);
      e.target.value = '';
    },
    [files, onFilesChange, maxFiles, disabled]
  );

  const removeFile = useCallback(
    (index: number) => {
      const newFiles = files.filter((_, i) => i !== index);
      onFilesChange(newFiles);
    },
    [files, onFilesChange]
  );

  return (
    <div className="space-y-4">
      {/* Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative border-2 border-dashed rounded-xl p-8 transition-all',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50',
          disabled && 'opacity-50 pointer-events-none'
        )}
      >
        <input
          type="file"
          multiple
          accept={acceptedTypes.join(',')}
          onChange={handleFileSelect}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          disabled={disabled}
        />
        <div className="flex flex-col items-center justify-center text-center">
          <div className="p-4 rounded-full bg-secondary mb-4">
            <Upload className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium mb-1">
            Drop files here or click to upload
          </p>
          <p className="text-xs text-muted-foreground">
            Supports PDF, TXT, and DOCX files (max {maxFiles})
          </p>
        </div>
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 border border-border"
            >
              <div className="p-2 rounded-lg bg-secondary">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(file.size)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => removeFile(index)}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface UploadProgressProps {
  filename: string;
  progress: number;
  status: 'uploading' | 'processing' | 'complete' | 'error';
  error?: string;
}

export function UploadProgress({
  filename,
  progress,
  status,
  error,
}: UploadProgressProps) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 border border-border">
      <div className="p-2 rounded-lg bg-secondary">
        {status === 'complete' ? (
          <FileText className="h-4 w-4 text-emerald-400" />
        ) : status === 'error' ? (
          <FileText className="h-4 w-4 text-red-400" />
        ) : (
          <Loader2 className="h-4 w-4 text-primary animate-spin" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium truncate">{filename}</p>
          <span className="text-xs text-muted-foreground">
            {status === 'uploading' && `${progress}%`}
            {status === 'processing' && 'Processing...'}
            {status === 'complete' && 'Ready'}
            {status === 'error' && 'Failed'}
          </span>
        </div>
        {status === 'error' && error && (
          <p className="text-xs text-red-400">{error}</p>
        )}
        {(status === 'uploading' || status === 'processing') && (
          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn(
                'h-full transition-all duration-300',
                status === 'processing'
                  ? 'bg-primary animate-pulse w-full'
                  : 'bg-primary'
              )}
              style={{ width: status === 'uploading' ? `${progress}%` : '100%' }}
            />
          </div>
        )}
      </div>
    </div>
  );
}





