'use client';

import { Button, IconButton, Field, Chip, Card, Skeleton, StateBlock, useToast } from '@/components/ui';

const row = { display: 'flex', flexWrap: 'wrap', gap: 'var(--gap-tight)' } as const;

export function Gallery() {
  const toast = useToast();
  return (
    <main
      id="main"
      style={{
        position: 'relative',
        zIndex: 2,
        padding: '5rem var(--pad-x) 3rem',
        display: 'grid',
        gap: 'var(--gap-section)',
        maxWidth: '56rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ fontSize: 'var(--text-xl)' }}>UI primitives</h1>
      <Card title="Buttons">
        <div style={row}>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" size="lg">
            Large
          </Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button disabled>Disabled</Button>
          <IconButton label="Settings">{'⚙'}</IconButton>
          <IconButton label="Close" variant="secondary">
            &times;
          </IconButton>
        </div>
      </Card>
      <Card title="Fields">
        <div style={{ display: 'grid', gap: 'var(--gap)' }}>
          <Field label="Hostname" hint="Public name of the service" placeholder="app.example.com" />
          <Field label="Token" error="That token was rejected." defaultValue="abc" />
          <Field label="Notes" as="textarea" placeholder="Optional" />
          <Field label="Mode" as="select" defaultValue="a">
            <option value="a">Ask</option>
            <option value="b">Agent</option>
          </Field>
          <Field label="Locked" disabled defaultValue="read only" />
          <label>
            <input type="checkbox" defaultChecked /> native checkbox (accent-color)
          </label>
        </div>
      </Card>
      <Card title="Chips">
        <div style={row}>
          <Chip>Neutral</Chip>
          <Chip tone="ok" dot>
            Operational
          </Chip>
          <Chip tone="warn" dot>
            Degraded
          </Chip>
          <Chip tone="down" dot>
            Down
          </Chip>
          <Chip tone="accent" mono>
            Agent
          </Chip>
          <Chip onClick={() => {}} pressed>
            Pressed
          </Chip>
          <Chip onClick={() => {}}>Button chip</Chip>
        </div>
      </Card>
      <Card title="Loading, empty, error">
        <div style={{ display: 'grid', gap: 'var(--gap)' }}>
          <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>
            <Skeleton width="40%" height="1.1rem" />
            <Skeleton height="0.9rem" />
            <Skeleton width="80%" height="0.9rem" />
          </div>
          <StateBlock title="Nothing here yet">Add a panel to start your dashboard.</StateBlock>
          <StateBlock
            kind="error"
            title="Could not reach the backend"
            details="size 64-3072 px, at least one selected pixel"
            action={<Button>Retry</Button>}
          >
            Check the connection and try again.
          </StateBlock>
        </div>
      </Card>
      <Card title="Elevation and motion">
        <div style={{ ...row, gap: 'var(--gap)' }}>
          <Card elevation="flat">flat</Card>
          <Card>shadow-1</Card>
          <Card elevation="raised">shadow-2</Card>
          <div
            className="pop"
            style={{
              padding: '1rem',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--surface)',
              boxShadow: 'var(--shadow-3)',
              border: '1px solid var(--border)',
            }}
          >
            shadow-3
          </div>
        </div>
        <div style={{ ...row, marginTop: 'var(--gap)' }}>
          <Button onClick={() => toast('Saved', 'success')}>Toast ok</Button>
          <Button onClick={() => toast('Could not save', 'error')}>Toast error</Button>
        </div>
      </Card>
      <p
        style={{
          fontSize: 'var(--text-2xs)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
        }}
      >
        text-2xs label
      </p>
    </main>
  );
}
