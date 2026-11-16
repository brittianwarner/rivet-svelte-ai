<script lang="ts">
  import { LIMITS } from "@example/entities/contracts";
  import { ago, clock, type ProjectViewModel } from "#lib/data/index.js";
  import Avatar from "./Avatar.svelte";

  let {
    project,
    taskId,
    writable,
  }: { project: ProjectViewModel; taskId: string; writable: boolean } =
    $props();

  // Opening the thread loads its newest page; live comments append on their own.
  $effect(() => {
    void project.openThread(taskId);
  });

  const thread = $derived(project.thread(taskId));
  let body = $state("");

  async function post(event: SubmitEvent) {
    event.preventDefault();
    const next = body.trim();
    if (!next) return;
    const done = await project.addComment(taskId, next);
    // Keep anything typed while the comment was being saved.
    if (done && body.trim() === next) body = "";
  }
</script>

<div class="thread">
  {#if !thread}
    <p class="muted">Loading comments…</p>
  {:else}
    {#if thread.before !== null}
      <button
        type="button"
        class="text-button older"
        disabled={project.isBusy(`thread:${taskId}`)}
        onclick={() => void project.loadOlderComments(taskId)}
        >{project.isBusy(`thread:${taskId}`)
          ? "Loading…"
          : "Show older comments"}</button
      >
    {/if}
    {#if thread.comments.length === 0}
      <p class="muted">No comments yet.</p>
    {:else}
      <ol class="comments">
        {#each thread.comments as comment (comment.commentId)}
          <li>
            <Avatar id={comment.authorId} name={comment.authorName} size={22} />
            <div>
              <p class="byline">
                <strong>{comment.authorName}</strong>
                <time datetime={new Date(comment.createdAt).toISOString()}
                  >{ago(comment.createdAt, clock.now)}</time
                >
              </p>
              <p class="body">{comment.body}</p>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
  {#if writable}
    <form class="reply" onsubmit={post}>
      <label class="sr-only" for={`comment-${taskId}`}>Comment</label>
      <input
        id={`comment-${taskId}`}
        bind:value={body}
        placeholder="Add a comment"
        autocomplete="off"
        maxlength={LIMITS.comment}
      />
      <button
        type="submit"
        class="secondary"
        disabled={!body.trim() ||
          !project.connected ||
          project.isBusy(`comment:${taskId}`)}
        >{project.isBusy(`comment:${taskId}`) ? "Posting…" : "Post"}</button
      >
    </form>
  {/if}
</div>

<style>
  .thread {
    display: grid;
    gap: 8px;
    margin: 4px 0 8px 30px;
    border-left: 1px solid var(--line);
    padding-left: 16px;
  }
  .older {
    justify-self: start;
    font-size: 12px;
  }
  .comments {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .comments li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .byline {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
  }
  .byline time {
    color: var(--muted);
    font-size: 12px;
  }
  .body {
    font-size: 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .reply {
    display: flex;
    gap: 8px;
  }
  .muted {
    color: var(--muted);
    font-size: 13px;
  }
</style>
