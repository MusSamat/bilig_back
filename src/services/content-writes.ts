/** Derivations applied to every dictionary write: owning subject (RBAC scope) and search text. */
import type { ContentKind, ContentKinds, ContentWrite, Repository } from '../repo/types.js';
import { searchTextOf } from '../domain/strings.js';

/**
 * Owning subject of a dictionary entry. Program structure follows its parent
 * chain; concepts, processes and items use the key prefix convention
 * (`bio.nucleus` → `bio`) when such a subject exists; otherwise they are
 * shared (null) and only platform-level editors may change them.
 */
export async function subjectKeyFor<K extends ContentKind>(repo: Repository, kind: K, key: string, data: ContentKinds[K]): Promise<string | null> {
  switch (kind) {
    case 'subject':
      return key;
    case 'course':
      return (data as ContentKinds['course']).subjectKey;
    case 'unit': {
      const c = await repo.content('course').get((data as ContentKinds['unit']).courseKey);
      return c?.data.subjectKey ?? null;
    }
    case 'objective': {
      const u = await repo.content('unit').get((data as ContentKinds['objective']).unitKey);
      const c = u ? await repo.content('course').get(u.data.courseKey) : null;
      return c?.data.subjectKey ?? null;
    }
    case 'concept':
    case 'process':
    case 'item': {
      const prefix = key.split(/[.]/)[0];
      return (await repo.content('subject').get(prefix)) ? prefix : null;
    }
    default:
      return null;
  }
}

export async function toWrite<K extends ContentKind>(repo: Repository, kind: K, key: string, data: ContentKinds[K]): Promise<ContentWrite<ContentKinds[K]>> {
  return { data, subjectKey: await subjectKeyFor(repo, kind, key, data), searchText: searchTextOf(data) };
}

/** Key of a dictionary entry (glossary terms use `id`). */
export const keyOf = (kind: ContentKind, data: { key?: string; id?: string }): string => (kind === 'glossary' ? data.id! : data.key!);
