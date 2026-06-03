# NPM Library Design — Distributed Rate Limit & Request Scheduling Manager

I want to design and publish an NPM library for managing third-party API rate limits in a scalable and flexible way.

## Problem Context

Many third-party providers apply strict rate limiting policies.
For example, Binance assigns a **weight** to each API endpoint.

Example:

* `GET /balance` → weight = `1`
* `POST /order` → weight = `5`

Binance may define a limit such as:

* Maximum total weight: `100`
* Time window: `1 minute`

If the accumulated request weight exceeds the allowed threshold, the client may be temporarily banned (for example, for 3 minutes).

The library must help applications avoid reaching the maximum threshold while still allowing efficient request execution.

---

# Goal

Design a reusable NPM package that:

* Tracks weighted API usage per provider
* Prevents hitting provider rate limits
* Supports configurable window-based policies
* Decides whether to:

  * reject requests immediately
  * delay them
  * queue them for later execution
* Works for multiple providers and multiple rate-limit strategies

---

# Example Scenario

Provider: Binance

Configuration:

```ts
{
  windowMs: 60_000,
  maxWeight: 100
}
```

Endpoints:

```ts
{
  "/balance": 1,
  "/order": 5
}
```

If the current consumed weight is `98` and a new request with weight `5` arrives:

* the library should detect that executing it would exceed the limit
* then decide:

  * reject immediately if low priority
  * or queue it until the next window becomes available

---

# Expected Features

## Core Features

* Weighted request tracking
* Sliding window or fixed window rate limiting
* Queue-based scheduling
* Priority handling
* Retry support
* Backpressure handling
* Burst protection
* Cooldown handling after provider ban/rate-limit response

---

# Queue Behavior

The library should support multiple strategies:

## 1. Reject Strategy

Reject the request immediately when executing it would exceed the limit.

Example use case:

* low-priority analytics requests

---

## 2. Queue Strategy

Push requests into an internal queue and execute them later when enough capacity becomes available.

Example use case:

* critical trading operations
* balance synchronization

---

# Architecture Expectations

Please help design:

* overall architecture
* core abstractions/interfaces
* queue management strategy
* rate-limit calculation algorithm
* time-window management
* concurrency handling
* provider-specific adapters
* extensibility model
* TypeScript API design
* event system/hooks
* in-memory vs distributed storage support
* Redis integration possibility
* worker/thread safety
* metrics and observability support

---

# Technical Requirements

* TypeScript
* Publishable to NPM
* Framework agnostic
* High performance
* Production ready
* Clean and extensible architecture
* Support async/await
* Minimal dependencies

---

# Additional Considerations

Please also evaluate:

* token bucket vs leaky bucket vs sliding window approaches
* distributed rate limiting challenges
* horizontal scaling considerations
* failure scenarios
* memory usage
* starvation prevention
* priority inversion problems
* queue overflow handling

---

# Deliverables

Please provide:

1. High-level architecture
2. Recommended algorithms
3. Core interfaces/classes
4. Suggested folder structure
5. Internal workflow diagrams
6. Edge cases and pitfalls
7. Scalability considerations
8. Example TypeScript API usage
9. Suggested testing strategy
10. Recommendations for v1 vs future versions
