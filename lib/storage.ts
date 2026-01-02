/**
 * Local Storage for Matters
 * 
 * Persists matter data to localStorage for the prototype.
 * In production, this would be a database.
 */

import { Matter } from './types';

const STORAGE_KEY = 'summary-analyzer-matters';

export function getMatters(): Matter[] {
  if (typeof window === 'undefined') return [];
  
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function getMatter(id: string): Matter | null {
  const matters = getMatters();
  return matters.find(m => m.id === id) || null;
}

export function saveMatter(matter: Matter): void {
  const matters = getMatters();
  const index = matters.findIndex(m => m.id === matter.id);
  
  if (index >= 0) {
    matters[index] = matter;
  } else {
    matters.unshift(matter);
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(matters));
}

export function deleteMatter(id: string): void {
  const matters = getMatters().filter(m => m.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(matters));
}

export function createMatterId(): string {
  return `matter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}



