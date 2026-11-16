import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from './page';

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders every landing section inside a single main landmark', () => {
    render(<HomePage />);
    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
    for (const name of ['How it works', 'Your week with VeriWork', 'For AI teams and sponsors', 'Built to be safe']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('links the brand mark back to the home page', () => {
    render(<HomePage />);
    expect(screen.getByRole('link', { name: 'VeriWork AI' })).toHaveAttribute('href', '/');
  });

  it('shows the source-code link from NEXT_PUBLIC_REPO_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_REPO_URL', 'https://github.com/zzzbedream/VeriworkAI');
    render(<HomePage />);
    expect(screen.getByRole('link', { name: 'Source code (MIT)' })).toHaveAttribute(
      'href',
      'https://github.com/zzzbedream/VeriworkAI',
    );
  });
});
