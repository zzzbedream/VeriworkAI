import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Hero } from './Hero';
import { ForSponsors, HowItWorks, Safety, SiteFooter } from './Sections';
import { WalletWeek } from './WalletWeek';

describe('Hero', () => {
  it('states the value proposition as the page heading', () => {
    render(<Hero />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Help train AI.');
    expect(heading).toHaveTextContent('Get paid in G$.');
  });

  it('links to the in-page sections for workers and sponsors', () => {
    render(<Hero />);
    expect(screen.getByRole('link', { name: 'See how it works' })).toHaveAttribute('href', '#how-it-works');
    expect(screen.getByRole('link', { name: 'Fund a campaign' })).toHaveAttribute('href', '#sponsors');
  });

  it('shows the three steps of one piece of work in order', () => {
    render(<Hero />);
    const steps = within(screen.getByRole('list', { name: 'One piece of work, step by step' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining('AI draft'),
      expect.stringContaining('You fix it'),
      expect.stringContaining('Collect your week in G$'),
    ]);
  });
});

describe('HowItWorks', () => {
  it('explains the four steps, including the free trial before verification', () => {
    render(<HowItWorks />);
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
    expect(screen.getByText(/Two free tasks before you verify/)).toBeInTheDocument();
  });
});

describe('WalletWeek', () => {
  it('lists the seven UBI days from Monday to Sunday', () => {
    render(<WalletWeek />);
    const days = screen.getAllByRole('listitem');
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveTextContent('Mon');
    expect(days[0]).toHaveTextContent('150 G$, you get it back Sunday');
    expect(days[4]).toHaveTextContent('+400 G$');
    expect(days[6]).toHaveTextContent('Collect your week');
  });

  it('anchors the week to the GoodDollar daily reset', () => {
    render(<WalletWeek />);
    expect(screen.getByText(/12:00 UTC/)).toBeInTheDocument();
  });
});

describe('ForSponsors', () => {
  it('states the UBI fee share and the verified-human guarantee', () => {
    render(<ForSponsors />);
    expect(screen.getByRole('heading', { name: 'For AI teams and sponsors' })).toBeInTheDocument();
    expect(screen.getByText('20% of every fee goes to the GoodDollar UBI pool')).toBeInTheDocument();
    expect(screen.getByText('One verified human per seat, checked on-chain')).toBeInTheDocument();
  });
});

describe('Safety', () => {
  it('lists the four safety guarantees without overclaiming a multisig', () => {
    render(<Safety />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(screen.getByText(/only the admin can resume/)).toBeInTheDocument();
    expect(screen.queryByText(/Safe/)).not.toBeInTheDocument();
  });
});

describe('SiteFooter', () => {
  it('credits both founders', () => {
    render(<SiteFooter repoUrl={undefined} />);
    expect(screen.getByText(/Lucas Cifuentes \(CEO\)/)).toBeInTheDocument();
    expect(screen.getByText(/Christian Perez de Arce \(CTO\)/)).toBeInTheDocument();
  });

  it('links to the source code only when a repository URL is configured', () => {
    const { rerender } = render(<SiteFooter repoUrl={undefined} />);
    expect(screen.queryByRole('link', { name: 'Source code (MIT)' })).not.toBeInTheDocument();
    rerender(<SiteFooter repoUrl="https://github.com/zzzbedream/VeriworkAI" />);
    expect(screen.getByRole('link', { name: 'Source code (MIT)' })).toHaveAttribute(
      'href',
      'https://github.com/zzzbedream/VeriworkAI',
    );
  });
});
