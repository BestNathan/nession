/**
 * Extend upstream dollar-only math syntax with TeX delimiters while reusing
 * its token vocabulary.
 *
 * Upstream: https://github.com/deepseek-ai/deepseek-harness
 * Baseline: 21638c56315ae6a2b552d6091945d3144c9af32e
 * Source: packages/client/ui-primitives/src/markdown/mathCompatibility.ts
 * License: MIT (see THIRD_PARTY_NOTICES.md)
 * Adaptation: Adopted; brace style and import extensions only. Note the
 * single-dollar split lives in the caller's `math()` options, not here — this
 * extension adds `\(...\)`, `\[...\]` and same-line `$$...$$`.
 */

import { factorySpace } from 'micromark-factory-space'
import type {} from 'micromark-extension-math'
import { markdownLineEnding } from 'micromark-util-character'
import { codes, constants, types } from 'micromark-util-symbol'
import type { Construct, Extension, Previous, State, Tokenizer } from 'micromark-util-types'

// oxlint-disable typescript/no-this-alias -- micromark binds tokenizer context only on the outer callback.

const previousBackslash: Previous = function (code) {
  if (code !== codes.backslash) {return true}
  const tail = this.events[this.events.length - 1]
  /* v8 ignore next -- a previous code necessarily has a preceding event. */
  if (tail === undefined) {return false}
  return tail[1].type === types.characterEscape
}

const tokenizeBackslashMathText: Tokenizer = function (effects, ok, nok) {
  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the text construct is dispatched only for a backslash. */
    if (code !== codes.backslash) {return nok(code)}
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }

  function open(code: number | null): State | undefined {
    if (code !== codes.leftParenthesis) {return nok(code)}
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: number | null): State | undefined {
    if (code === codes.eof) {return nok(code)}
    if (code === codes.backslash) {
      return effects.attempt({ partial: true, tokenize: tokenizeClose }, close, afterCloseAttempt)(code)
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      return between
    }
    return dataStart(code)
  }

  function afterCloseAttempt(code: number | null): State | undefined {
    return effects.check({ partial: true, tokenize: tokenizeOpen }, nok, dataStart)(code)
  }

  function dataStart(code: number | null): State | undefined {
    effects.enter('mathTextData')
    effects.consume(code)
    return code === codes.backslash ? afterDataBackslash : data
  }

  function afterDataBackslash(code: number | null): State | undefined {
    if (code === codes.backslash) {
      effects.consume(code)
      return data
    }
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || code === codes.backslash || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    effects.consume(code)
    return data
  }

  function close(code: number | null): State | undefined {
    effects.exit('mathText')
    return ok(code)
  }

  function tokenizeClose(closeEffects: Parameters<Tokenizer>[0], closeOk: State, closeNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- this partial construct is attempted only at a backslash. */
      if (code !== codes.backslash) {return closeNok(code)}
      closeEffects.enter('mathTextSequence')
      closeEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.rightParenthesis) {return closeNok(code)}
      closeEffects.consume(code)
      closeEffects.exit('mathTextSequence')
      return closeOk
    }
  }

  function tokenizeOpen(openEffects: Parameters<Tokenizer>[0], openOk: State, openNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- the opening check follows a failed close attempt at a backslash. */
      if (code !== codes.backslash) {return openNok(code)}
      openEffects.enter(types.chunkString)
      openEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.leftParenthesis) {return openNok(code)}
      openEffects.consume(code)
      openEffects.exit(types.chunkString)
      return openOk
    }
  }
}

function tokenizeMathFlowClosingFence(
  marker: number,
  closeMarker: number,
): Tokenizer {
  return function (closeEffects, closeOk, closeNok) {
    return factorySpace(closeEffects, sequenceStart, types.linePrefix, constants.tabSize)

    function sequenceStart(code: number | null): State | undefined {
      if (code !== marker) {return closeNok(code)}
      closeEffects.enter('mathFlowFence')
      closeEffects.enter('mathFlowFenceSequence')
      closeEffects.consume(code)
      return sequenceEnd
    }

    function sequenceEnd(code: number | null): State | undefined {
      if (code !== closeMarker) {return closeNok(code)}
      closeEffects.consume(code)
      closeEffects.exit('mathFlowFenceSequence')
      return factorySpace(closeEffects, after, types.whitespace)
    }

    function after(code: number | null): State | undefined {
      if (code !== codes.eof && !markdownLineEnding(code)) {return closeNok(code)}
      closeEffects.exit('mathFlowFence')
      return closeOk(code)
    }
  }
}

function tokenizeMathFlowOpeningFence(
  marker: number,
): Tokenizer {
  return function (openEffects, openOk, openNok) {
    return sequenceStart

    function sequenceStart(code: number | null): State | undefined {
      /* v8 ignore next -- the opening check follows a failed close attempt at the marker. */
      if (code !== marker) {return openNok(code)}
      openEffects.enter(types.chunkString)
      openEffects.consume(code)
      return sequenceEnd
    }

    function sequenceEnd(code: number | null): State | undefined {
      /* v8 ignore next -- the opening fence is followed by whitespace or end. */
      if (code !== codes.eof && !markdownLineEnding(code)) {return openNok(code)}
      openEffects.exit(types.chunkString)
      return openOk(code)
    }
  }
}

function createMathFlow(marker: number, openMarker: number, closeMarker: number, multiline: boolean): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    let oddBackslashRun = false
    const tail = this.events[this.events.length - 1]
    const initialSize = tail?.[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0

    return start

    function start(code: number | null): State | undefined {
      /* v8 ignore next -- the flow construct is dispatched only for its marker. */
      if (code !== marker) {return nok(code)}
      effects.enter('mathFlow')
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return open
    }

    function open(code: number | null): State | undefined {
      if (code !== openMarker) {return nok(code)}
      effects.consume(code)
      effects.exit('mathFlowFenceSequence')
      effects.exit('mathFlowFence')
      return marker === codes.dollarSign ? afterDollarOpen : content
    }

    function afterDollarOpen(code: number | null): State | undefined {
      return code === codes.dollarSign ? nok(code) : content(code)
    }

    function content(code: number | null): State | undefined {
      if (code === codes.eof) {return nok(code)}
      if (code === marker && (marker !== codes.dollarSign || !oddBackslashRun)) {
        return effects.attempt(
          { partial: true, tokenize: tokenizeMathFlowClosingFence(marker, closeMarker) },
          closed,
          afterClosingFenceAttempt,
        )(code)
      }
      if (markdownLineEnding(code)) {
        return multiline
          ? effects.attempt(nonLazyContinuation, afterContinuation, nok)(code)
          : nok(code)
      }
      return valueStart(code)
    }

    function afterClosingFenceAttempt(code: number | null): State | undefined {
      return marker === codes.backslash
        ? effects.check({ partial: true, tokenize: tokenizeMathFlowOpeningFence(marker) }, nok, markerValueStart)(code)
        : markerValueStart(code)
    }

    function afterContinuation(code: number | null): State | undefined {
      return effects.attempt(
        { partial: true, tokenize: tokenizeMathFlowClosingFence(marker, closeMarker) },
        closed,
        initialSize
          ? factorySpace(effects, content, types.linePrefix, initialSize + 1)
          : content,
      )(code)
    }

    function valueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = code === codes.backslash
      effects.consume(code)
      return value
    }

    function markerValueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = false
      effects.consume(code)
      return valueAfterMarker
    }

    function valueAfterMarker(code: number | null): State | undefined {
      if (code === marker) {
        effects.consume(code)
        return value
      }
      return value(code)
    }

    function value(code: number | null): State | undefined {
      if (code === codes.eof || code === marker || markdownLineEnding(code)) {
        effects.exit('mathFlowValue')
        return content(code)
      }
      oddBackslashRun = code === codes.backslash ? !oddBackslashRun : false
      effects.consume(code)
      return value
    }

    function closed(code: number | null): State | undefined {
      effects.exit('mathFlow')
      return ok(code)
    }
  }

  return {
    concrete: true,
    name: marker === codes.dollarSign ? 'sameLineDollarMathFlow' : 'backslashMathFlow',
    tokenize,
  }
}

const tokenizeNonLazyContinuation: Tokenizer = function (effects, ok, nok) {
  // Declared *before* `return start`, and that position is load-bearing: the
  // `return` exits the tokenizer body, so an initializer written after it
  // never runs and the state `start` returns stays in its temporal dead zone.
  // A `const lineStart` below the return made every multi-line `\[...\]`
  // block throw `Cannot access 'lineStart' before initialization` (#1184
  // browser verification); the arrow keeps `this` as the tokenizer's context.
  const lineStart = (code: number | null): State | undefined => {
    return this.parser.lazy[this.now().line] ? nok(code) : ok(code)
  }

  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (code === codes.eof) {return ok(code)}
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (!markdownLineEnding(code)) {return nok(code)}
    effects.enter(types.lineEnding)
    effects.consume(code)
    effects.exit(types.lineEnding)
    return lineStart
  }
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation,
}

const backslashMathText: Construct = {
  name: 'backslashMathText',
  previous: previousBackslash,
  tokenize: tokenizeBackslashMathText,
}

const backslashMathFlow = createMathFlow(
  codes.backslash,
  codes.leftSquareBracket,
  codes.rightSquareBracket,
  true,
)

const sameLineDollarMathFlow = createMathFlow(
  codes.dollarSign,
  codes.dollarSign,
  codes.dollarSign,
  false,
)

const backslashMath: Extension = {
  flow: {
    [codes.backslash]: backslashMathFlow,
    [codes.dollarSign]: sameLineDollarMathFlow,
  },
  text: { [codes.backslash]: backslashMathText },
}

/**
 * TeX backslash delimiters and same-line display-dollar blocks as a micromark
 * syntax extension reusing `micromark-extension-math`'s token vocabulary; the
 * caller must also register `math()` on the same parse so the emitted tokens
 * compile to standard math nodes.
 * @returns The micromark syntax extension.
 */
export function mathCompatibility(): Extension {
  return backslashMath
}
