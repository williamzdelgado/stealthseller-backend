import { validateAsinFormat } from './validation.ts';

export function determineNewAsins(existing: string[], incoming: string[]): string[] {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    return [];
  }
  
  const existingSet = new Set(existing.map(asin => asin.toUpperCase()));
  
  return incoming
    .filter(asin => asin && typeof asin === 'string')
    .map(asin => asin.toUpperCase())
    .filter(asin => !existingSet.has(asin));
}

export function deduplicateAsins(asins: string[]): string[] {
  if (!Array.isArray(asins)) {
    return [];
  }
  
  const seen = new Set<string>();
  const result: string[] = [];
  
  for (const asin of asins) {
    if (asin && typeof asin === 'string') {
      const normalized = asin.toUpperCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }
  
  return result;
}

export function normalizeAsin(asin: string): string {
  if (!asin || typeof asin !== 'string') {
    return '';
  }
  
  return asin.trim().toUpperCase();
}

export function filterValidAsins(asins: string[]): string[] {
  if (!Array.isArray(asins)) {
    return [];
  }
  
  return asins
    .map(asin => normalizeAsin(asin))
    .filter(asin => validateAsinFormat(asin));
}

export function compareAsinLists(
  oldList: string[], 
  newList: string[]
): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const oldSet = new Set(oldList.map(asin => normalizeAsin(asin)));
  const newSet = new Set(newList.map(asin => normalizeAsin(asin)));
  
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  
  for (const asin of newSet) {
    if (!oldSet.has(asin)) {
      added.push(asin);
    } else {
      unchanged.push(asin);
    }
  }
  
  for (const asin of oldSet) {
    if (!newSet.has(asin)) {
      removed.push(asin);
    }
  }
  
  return { added, removed, unchanged };
}

export function mergeAsinLists(...lists: string[][]): string[] {
  const merged = new Set<string>();
  
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const asin of list) {
        const normalized = normalizeAsin(asin);
        if (normalized && validateAsinFormat(normalized)) {
          merged.add(normalized);
        }
      }
    }
  }
  
  return Array.from(merged);
}

export function chunkAsins(asins: string[], chunkSize: number): string[][] {
  if (!Array.isArray(asins) || chunkSize <= 0) {
    return [];
  }
  
  const chunks: string[][] = [];
  
  for (let i = 0; i < asins.length; i += chunkSize) {
    chunks.push(asins.slice(i, i + chunkSize));
  }
  
  return chunks;
}

export function countAsins(asins: string[] | undefined | null): number {
  if (!Array.isArray(asins)) {
    return 0;
  }
  
  return asins.filter(asin => asin && typeof asin === 'string').length;
}