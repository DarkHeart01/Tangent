package codeintel

import (
	"context"
	"sort"
	"sync"
	"time"
)

// signatureResolver is satisfied by TSAdapter (and, later, any other Tier-A
// adapter) -- kept as an interface so the queue itself stays adapter-agnostic.
type signatureResolver interface {
	ResolveSignature(ctx context.Context, e Edge) (Signature, error)
}

type resolutionJob struct {
	edge     Edge
	enqueued time.Time
}

// ResolutionQueue is spec ??6's async resolution pipeline for on-demand
// signature lookups (existence/dangling detection itself doesn't need a
// queue -- it comes from the language server's own diagnostics push, handled
// directly in TSAdapter.applyDiagnostics). Jobs are reprioritized by
// proximity to the cursor's last-known position rather than strict FIFO, so
// a reference just typed at the cursor jumps ahead of earlier-queued
// resolutions for files no longer in view.
type ResolutionQueue struct {
	resolver   signatureResolver
	onResolved func(edgeID string, sig Signature)

	mu         sync.Mutex
	jobs       []resolutionJob
	cursorFile string
	cursorLine int

	wake      chan struct{}
	closeOnce sync.Once
	closed    chan struct{}
}

func NewResolutionQueue(resolver signatureResolver, onResolved func(edgeID string, sig Signature)) *ResolutionQueue {
	q := &ResolutionQueue{
		resolver:   resolver,
		onResolved: onResolved,
		wake:       make(chan struct{}, 1),
		closed:     make(chan struct{}),
	}
	go q.run()
	return q
}

// SetCursor records the cursor's last-known position; call it on every
// cursor move so newly enqueued jobs near it are reprioritized ahead of
// older jobs elsewhere.
func (q *ResolutionQueue) SetCursor(filePath string, line int) {
	q.mu.Lock()
	q.cursorFile = filePath
	q.cursorLine = line
	q.mu.Unlock()
}

// Enqueue schedules signature resolution for e. A no-op if e is already
// queued (resolution is idempotent and cheap to skip-dedupe on the edge id).
func (q *ResolutionQueue) Enqueue(e Edge) {
	q.mu.Lock()
	for _, j := range q.jobs {
		if j.edge.ID == e.ID {
			q.mu.Unlock()
			return
		}
	}
	q.jobs = append(q.jobs, resolutionJob{edge: e, enqueued: time.Now()})
	q.mu.Unlock()

	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// run is a single-worker loop -- deliberately not parallel, since a
// language server process handles one request at a time internally anyway
// and a worker pool here would just add contention without real throughput
// gains. Wrapped in recover() like every other long-lived goroutine in this
// app (TerminalManager.readOutput, LSPClient.readLoop) so a resolver panic
// can't take the whole process down.
func (q *ResolutionQueue) run() {
	defer func() { _ = recover() }()
	for {
		select {
		case <-q.closed:
			return
		case <-q.wake:
		}
		for {
			job, ok := q.dequeueNext()
			if !ok {
				break
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			sig, err := q.resolver.ResolveSignature(ctx, job.edge)
			cancel()
			if err == nil && q.onResolved != nil {
				q.onResolved(job.edge.ID, sig)
			}
		}
	}
}

func (q *ResolutionQueue) dequeueNext() (resolutionJob, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.jobs) == 0 {
		return resolutionJob{}, false
	}
	sort.SliceStable(q.jobs, func(i, j int) bool {
		return q.priority(q.jobs[i].edge) > q.priority(q.jobs[j].edge)
	})
	job := q.jobs[0]
	q.jobs = q.jobs[1:]
	return job, true
}

// priority scores same-file jobs far above other-file jobs, then by
// closeness to the cursor's last-known line within that file.
func (q *ResolutionQueue) priority(e Edge) int {
	if e.FilePath != q.cursorFile {
		return 0
	}
	distance := e.Span.StartLine - q.cursorLine
	if distance < 0 {
		distance = -distance
	}
	const sameFileBase = 1 << 20
	return sameFileBase - distance
}

func (q *ResolutionQueue) Close() {
	q.closeOnce.Do(func() { close(q.closed) })
}
