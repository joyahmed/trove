// The search box hook: what the field shows, Enter / Escape, typing, and when it is enabled.
// `search` and `tabs` are plain stand-ins; the hook only reads and writes their fields.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock, tabsMock } = vi.hoisted(() => ({
  searchMock: {
    active: false,
    text: '',
    start: vi.fn<(t: string) => Promise<void>>(async () => {}),
    clear: vi.fn(),
  },
  tabsMock: {
    active: {
      location: { kind: 'path', path: '/home/alex/Downloads' } as unknown,
      filter: '',
      isFolder: true,
      path: '/home/alex/Downloads',
    },
  },
}));
vi.mock('$lib/state/search.svelte', () => ({ search: searchMock }));
vi.mock('$lib/state/tabs.svelte', () => ({ tabs: tabsMock }));

const { useSearchBox } = await import('./use-search-box.svelte');

const input = (value: string) => ({ value, blur: vi.fn() });
const typed = (el: ReturnType<typeof input>) => ({ currentTarget: el }) as unknown as Event;
const key = (k: string, el: ReturnType<typeof input>) => {
  const e = { key: k, currentTarget: el, preventDefault: vi.fn() };
  return e as typeof e & KeyboardEvent;
};

beforeEach(() => {
  searchMock.active = false;
  searchMock.text = '';
  searchMock.start.mockClear();
  searchMock.clear.mockClear();
  tabsMock.active.location = { kind: 'path', path: '/home/alex/Downloads' };
  tabsMock.active.filter = '';
  tabsMock.active.isFolder = true;
  tabsMock.active.path = '/home/alex/Downloads';
});

describe('useSearchBox state', () => {
  it('names the place in the placeholder, following the tab', () => {
    const box = useSearchBox();
    expect(box.placeholder).toBe('Search Downloads');
    tabsMock.active.location = { kind: 'home' };
    expect(box.placeholder).toBe('Search Home');
  });

  it('shows the instant filter until a search runs, then the search text', () => {
    const box = useSearchBox();
    tabsMock.active.filter = 'rep';
    expect(box.value).toBe('rep');
    expect(box.nonEmpty).toBe(true);
    searchMock.active = true;
    searchMock.text = 'report';
    expect(box.value).toBe('report');
    searchMock.text = '';
    expect(box.nonEmpty).toBe(false);
  });

  it('is empty and not nonEmpty with nothing typed', () => {
    const box = useSearchBox();
    expect(box.value).toBe('');
    expect(box.nonEmpty).toBe(false);
  });

  it('is disabled only on an empty folder tab; a place always searches', () => {
    const box = useSearchBox();
    expect(box.enabled).toBe(true);
    tabsMock.active.path = '';
    expect(box.enabled).toBe(false);
    tabsMock.active.isFolder = false;
    expect(box.enabled).toBe(true);
  });
});

describe('useSearchBox.oninput', () => {
  it('filters the folder while no search runs', () => {
    useSearchBox().oninput(typed(input('abc')));
    expect(tabsMock.active.filter).toBe('abc');
    expect(searchMock.text).toBe('');
    expect(searchMock.clear).not.toHaveBeenCalled();
  });

  it('edits the search text while a search runs, leaving the filter alone', () => {
    searchMock.active = true;
    useSearchBox().oninput(typed(input('abcd')));
    expect(searchMock.text).toBe('abcd');
    expect(tabsMock.active.filter).toBe('');
  });

  it('clears both when a running search is emptied', () => {
    searchMock.active = true;
    tabsMock.active.filter = 'x';
    useSearchBox().oninput(typed(input('')));
    expect(searchMock.clear).toHaveBeenCalledOnce();
    expect(tabsMock.active.filter).toBe('');
  });

  it('does not clear a search when the filter is emptied', () => {
    tabsMock.active.filter = 'a';
    useSearchBox().oninput(typed(input('')));
    expect(tabsMock.active.filter).toBe('');
    expect(searchMock.clear).not.toHaveBeenCalled();
  });
});

describe('useSearchBox.onkeydown', () => {
  it('Enter searches the trimmed text, drops the filter and swallows the key', () => {
    tabsMock.active.filter = 'rep';
    const e = key('Enter', input('  report  '));
    useSearchBox().onkeydown(e);
    expect(searchMock.start).toHaveBeenCalledWith('report');
    expect(tabsMock.active.filter).toBe('');
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('Enter on blank text does nothing and keeps the filter', () => {
    tabsMock.active.filter = 'keep';
    const e = key('Enter', input('   '));
    useSearchBox().onkeydown(e);
    expect(searchMock.start).not.toHaveBeenCalled();
    expect(tabsMock.active.filter).toBe('keep');
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('Escape clears filter and search, blurs the field and swallows the key', () => {
    tabsMock.active.filter = 'rep';
    const el = input('rep');
    const e = key('Escape', el);
    useSearchBox().onkeydown(e);
    expect(tabsMock.active.filter).toBe('');
    expect(searchMock.clear).toHaveBeenCalledOnce();
    expect(el.blur).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves other keys alone', () => {
    const e = key('a', input('a'));
    useSearchBox().onkeydown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(searchMock.start).not.toHaveBeenCalled();
    expect(searchMock.clear).not.toHaveBeenCalled();
  });
});

describe('useSearchBox.clear', () => {
  it('empties the filter and ends the search', () => {
    tabsMock.active.filter = 'x';
    useSearchBox().clear();
    expect(tabsMock.active.filter).toBe('');
    expect(searchMock.clear).toHaveBeenCalledOnce();
  });
});
