<script lang="ts">
  import type { Beat, StoryEdge, StoryNode } from "./types";

  interface Props {
    nodes: StoryNode[];
    edges: StoryEdge[];
    /** Node ids on stage at this beat. */
    visible: Set<string>;
    /** Node ids that just left; drawn fading out. */
    leaving: Set<string>;
    beat: Beat;
    /** Changes every beat so packet animations restart. */
    tick: number;
  }

  let { nodes, edges, visible, leaving, beat, tick }: Props = $props();

  const W = 100;
  const H = 60;
  const byId = $derived(new Map(nodes.map((node) => [node.id, node])));
  const focus = $derived(new Set(beat.focus ?? []));
  const onStage = (id: string) => visible.has(id) || leaving.has(id);
  const shown = $derived(
    edges.filter((edge) => onStage(edge.from) && onStage(edge.to)),
  );
  const flowing = $derived(
    new Map((beat.flows ?? []).map((flow) => [flow.edge, flow])),
  );

  const glyph: Record<StoryNode["kind"], string> = {
    client: "◐",
    actor: "■",
    agent: "◆",
    fork: "◇",
    sandbox: "▣",
    service: "○",
    store: "≡",
  };

  function path(edge: StoryEdge, back = false): string {
    const a = byId.get(back ? edge.to : edge.from);
    const b = byId.get(back ? edge.from : edge.to);
    if (!a || !b) return "";
    // A slight bend keeps parallel edges and their labels apart.
    const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.08;
    const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.08;
    return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
  }

  function midpoint(edge: StoryEdge): { x: number; y: number } {
    const a = byId.get(edge.from)!;
    const b = byId.get(edge.to)!;
    return {
      x: (a.x + b.x) / 2 + (b.y - a.y) * 0.04,
      y: (a.y + b.y) / 2 - (b.x - a.x) * 0.04,
    };
  }
</script>

<div class="stage" role="img" aria-label={`Diagram: ${beat.title}`}>
  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
    {#each shown as edge (edge.id)}
      <path
        d={path(edge)}
        class="edge"
        class:dashed={edge.dashed}
        class:active={flowing.has(edge.id)}
        class:fading={leaving.has(edge.from) || leaving.has(edge.to)}
        vector-effect="non-scaling-stroke"
      />
    {/each}
    {#key tick}
      {#each shown as edge (edge.id)}
        {@const flow = flowing.get(edge.id)}
        {#if flow}
          <circle r="0.9" class="packet">
            <animateMotion
              dur="1.6s"
              repeatCount="indefinite"
              path={path(edge, flow.back)}
            />
          </circle>
        {/if}
      {/each}
    {/key}
  </svg>

  {#each shown as edge (edge.id)}
    {@const flow = flowing.get(edge.id)}
    {#if flow}
      {@const mid = midpoint(edge)}
      <span
        class="flow-label"
        style:left={`${mid.x}%`}
        style:top={`${(mid.y / H) * 100}%`}
      >
        {flow.back ? "← " : ""}{flow.label}{flow.back ? "" : " →"}
      </span>
    {/if}
  {/each}

  {#each nodes as node (node.id)}
    {#if onStage(node.id)}
      <div
        class="node"
        data-kind={node.kind}
        class:focus={focus.has(node.id)}
        class:dim={focus.size > 0 && !focus.has(node.id)}
        class:leaving={leaving.has(node.id)}
        style:left={`${node.x}%`}
        style:top={`${(node.y / H) * 100}%`}
      >
        <span class="kind" aria-hidden="true">{glyph[node.kind]}</span>
        <span class="text">
          <strong>{node.label}</strong>
          {#if node.key}<code>{node.key}</code>{/if}
        </span>
        {#if beat.status?.[node.id]}
          <span class="badge">{beat.status[node.id]}</span>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .stage {
    position: relative;
    aspect-ratio: 5 / 3;
    width: 100%;
    background:
      linear-gradient(var(--line) 1px, transparent 1px) 0 0 / 5% 8.333%,
      linear-gradient(90deg, var(--line) 1px, transparent 1px) 0 0 / 5% 8.333%,
      var(--paper);
    background-blend-mode: normal;
    border: 1px solid var(--ink);
    overflow: hidden;
  }
  .stage::after {
    content: "";
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--paper) 72%, transparent);
    pointer-events: none;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
  }
  .edge {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.25;
    opacity: 0.55;
    transition:
      opacity 0.3s,
      stroke 0.3s;
  }
  .edge.dashed {
    stroke-dasharray: 4 4;
  }
  .edge.active {
    stroke: var(--red);
    stroke-width: 2;
    opacity: 1;
  }
  .edge.fading {
    opacity: 0.15;
  }
  .packet {
    fill: var(--red);
  }
  .flow-label {
    position: absolute;
    z-index: 3;
    transform: translate(-50%, -50%);
    padding: 2px 7px;
    background: var(--ink);
    color: var(--paper);
    font: 11px/1.4 var(--mono);
    white-space: nowrap;
    animation: rise 0.35s ease-out both;
  }
  .node {
    position: absolute;
    z-index: 2;
    transform: translate(-50%, -50%);
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 10px;
    min-width: 128px;
    max-width: 30%;
    padding: 10px 12px;
    background: var(--paper);
    border: 1px solid var(--ink);
    box-shadow: 4px 4px 0 var(--ink);
    animation: enter 0.4s ease-out both;
    transition:
      opacity 0.3s,
      box-shadow 0.3s,
      transform 0.3s;
  }
  .node[data-kind="fork"] {
    border-style: dashed;
  }
  .node[data-kind="service"] {
    border-radius: 999px;
    box-shadow: none;
  }
  .node[data-kind="store"] {
    box-shadow: none;
    background: var(--surface);
  }
  .node.focus {
    box-shadow: 4px 4px 0 var(--red);
    border-color: var(--red);
  }
  .node.dim {
    opacity: 0.55;
  }
  .node.leaving {
    animation: leave 0.6s ease-in both;
  }
  .kind {
    font-size: 18px;
    line-height: 1;
    color: var(--red);
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .text strong {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text code {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    position: absolute;
    top: -11px;
    right: -8px;
    padding: 1px 7px;
    background: var(--red);
    color: var(--paper);
    font: 10px/1.6 var(--mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    animation: rise 0.3s ease-out both;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translate(-50%, -38%) scale(0.96);
    }
  }
  @keyframes leave {
    to {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.85);
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      translate: 0 4px;
    }
  }
  @media (max-width: 700px) {
    .node {
      min-width: 0;
      gap: 6px;
      padding: 6px 8px;
      box-shadow: 3px 3px 0 var(--ink);
    }
    .text strong {
      font-size: 12px;
    }
    .text code,
    .flow-label {
      font-size: 9px;
    }
    .kind {
      font-size: 14px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .node,
    .node.leaving,
    .badge,
    .flow-label {
      animation: none;
    }
    .packet {
      display: none;
    }
    .node.leaving {
      opacity: 0.2;
    }
  }
</style>
