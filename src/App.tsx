import { useEffect, useMemo, useState } from 'react'
import './App.css'

type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs'
type Rank = 'A' | 'K' | 'Q' | 'J' | '10' | '9' | '8' | '7' | '6' | '5' | '4' | '3' | '2'
type RoundPhase = 'betting' | 'dealing' | 'playerTurn' | 'dealerTurn' | 'roundOver'

type Card = {
  id: string
  rank: Rank
  suit: Suit
}

type HandResult = 'win' | 'lose' | 'push'

type PlayerHand = {
  cards: Card[]
  bet: number
  isDone: boolean
  isStanding: boolean
  isBusted: boolean
  isBlackjack: boolean
  isDoubled: boolean
  isSplitAces: boolean
  result?: HandResult
}

type Stats = {
  rounds: number
  wins: number
  losses: number
  pushes: number
}

type LobbyPlayer = {
  id: string
  name: string
  bank: number
  joinedAt: number
  ready: boolean
}

type LobbyResponse = {
  lobby: 'main'
  players: LobbyPlayer[]
}

type JoinLobbyResponse = LobbyResponse & {
  player: {
    id: string
    name: string
    bank: number
  }
  token: string
}

type DealerCard = Card | { id: string; hidden: true }

type MultiplayerPlayer = {
  id: string
  name: string
  bank: number
  betStack: number[]
  bet: number
  cards: Card[]
  hands: {
    cards: Card[]
    bet: number
    isDone: boolean
    isBusted: boolean
    isStanding: boolean
    isDoubled: boolean
    result: HandResult | null
    resultReason: string
  }[]
  currentHandIndex: number
  isDone: boolean
  isBusted: boolean
  isStanding: boolean
  isDoubled: boolean
  result: HandResult | 'tie' | null
  resultReason: string
  ready: boolean
}

type MultiplayerState = {
  phase: RoundPhase | 'betting'
  message: string
  dealerCards: DealerCard[]
  dealerRevealed: boolean
  currentTurnPlayerId: string | null
  players: MultiplayerPlayer[]
  you: string | null
}

const SUITS: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs']
const RANKS: Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']
const SUIT_SYMBOL: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
}

const BLACKJACK_PAYOUT = 1.5
const SHOE_DECKS = 1
const DEALER_HITS_SOFT_17 = false
const MIN_BET = 5
const DEALER_REVEAL_DELAY_MS = 900
const DEALER_DRAW_DELAY_MS = 1000
const INITIAL_DEAL_DELAY_MS = 350
const CHIP_VALUES = [5, 50, 100, 500, 1000, 5000, 10000] as const
const RESHUFFLE_THRESHOLD = 15
const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `${window.location.protocol}//${window.location.hostname}:4000`
const DEVICE_ID_STORAGE_KEY = 'blackjack_device_id'
const MP_NAME_STORAGE_KEY = 'blackjack_mp_name'
const MODE_STORAGE_KEY = 'blackjack_mode'

function getDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
  if (existing) return existing
  const created = `d_${Math.random().toString(36).slice(2, 12)}_${Date.now().toString(36)}`
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created)
  return created
}

function shuffle<T>(items: T[]): T[] {
  const deck = [...items]
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

function buildShoe(deckCount: number): Card[] {
  const cards: Card[] = []
  for (let d = 0; d < deckCount; d += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({
          id: `${d}-${rank}-${suit}-${Math.random().toString(36).slice(2)}`,
          rank,
          suit,
        })
      }
    }
  }
  return shuffle(cards)
}

function rankValue(rank: Rank): number {
  if (rank === 'A') return 11
  if (['K', 'Q', 'J'].includes(rank)) return 10
  return Number(rank)
}

function handTotals(cards: Card[]) {
  let total = cards.reduce((sum, card) => sum + rankValue(card.rank), 0)
  let aces = cards.filter((card) => card.rank === 'A').length

  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }

  const isSoft = cards.some((card) => card.rank === 'A') && total <= 21 && aces > 0

  return {
    best: total,
    isSoft,
  }
}

function isBlackjack(cards: Card[]) {
  return cards.length === 2 && handTotals(cards).best === 21
}

function canSplit(hand: PlayerHand) {
  if (hand.cards.length !== 2) return false
  return hand.cards[0].rank === hand.cards[1].rank
}

function createHand(cards: Card[], bet: number, splitAces = false): PlayerHand {
  const total = handTotals(cards).best
  return {
    cards,
    bet,
    isDone: false,
    isStanding: false,
    isBusted: total > 21,
    isBlackjack: !splitAces && isBlackjack(cards),
    isDoubled: false,
    isSplitAces: splitAces,
  }
}

function drawCard(shoe: Card[]): { card: Card; nextShoe: Card[] } {
  const [card, ...nextShoe] = shoe
  if (!card) throw new Error('No cards left in shoe')
  return { card, nextShoe }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function maxAffordableBet(bankroll: number) {
  if (bankroll < MIN_BET) return 0
  return Math.floor(bankroll / MIN_BET) * MIN_BET
}

function stackForAmount(amount: number): number[] {
  let remaining = amount
  const stack: number[] = []

  for (const value of [...CHIP_VALUES].reverse()) {
    while (remaining >= value) {
      stack.push(value)
      remaining -= value
    }
  }

  return stack
}

function SingleplayerGame() {
  const [shoe, setShoe] = useState<Card[]>(() => buildShoe(SHOE_DECKS))
  const [dealerCards, setDealerCards] = useState<Card[]>([])
  const [hands, setHands] = useState<PlayerHand[]>([])
  const [bankroll, setBankroll] = useState(1000)
  const [chipStack, setChipStack] = useState<number[]>(() => stackForAmount(100))
  const [betPotChips, setBetPotChips] = useState<number[]>([])
  const [lastRoundBet, setLastRoundBet] = useState(100)
  const [phase, setPhase] = useState<RoundPhase>('betting')
  const [currentHand, setCurrentHand] = useState(0)
  const [, setStatus] = useState('Place your bet to begin.')
  const [stats, setStats] = useState<Stats>({ rounds: 0, wins: 0, losses: 0, pushes: 0 })
  const [dealerHoleRevealed, setDealerHoleRevealed] = useState(false)
  const [dealerIsThinking, setDealerIsThinking] = useState(false)
  const [roundSummary, setRoundSummary] = useState('')
  const [roundDetails, setRoundDetails] = useState('')
  const [roundIsGold, setRoundIsGold] = useState(false)

  const dealerVisible = dealerHoleRevealed || phase === 'roundOver'
  const stagedBet = chipStack.reduce((sum, chip) => sum + chip, 0)
  const tableBet = phase === 'betting' ? stagedBet : hands.reduce((sum, hand) => sum + hand.bet, 0)
  const displayedPot = phase === 'betting' ? chipStack : betPotChips
  const topPotChip = displayedPot[displayedPot.length - 1]
  const remainingBankroll = bankroll - stagedBet
  const availableChips = CHIP_VALUES.filter((value) => value <= remainingBankroll)

  const dealerTotalText = useMemo(() => {
    if (!dealerCards.length) return '--'

    if (!dealerVisible) {
      const upCard = dealerCards[0]
      return String(handTotals([upCard]).best)
    }

    const totals = handTotals(dealerCards)
    return totals.isSoft ? `${totals.best} (soft)` : String(totals.best)
  }, [dealerCards, dealerVisible])

  function ensureShoeHasCards(currentShoe: Card[]) {
    if (currentShoe.length < RESHUFFLE_THRESHOLD) {
      setStatus('Shoe reshuffled.')
      return buildShoe(SHOE_DECKS)
    }
    return currentShoe
  }

  function chipClass(value: number) {
    if (value <= 5) return 'chip-5'
    if (value <= 50) return 'chip-50'
    if (value <= 100) return 'chip-100'
    if (value <= 500) return 'chip-500'
    if (value <= 1000) return 'chip-1000'
    if (value <= 5000) return 'chip-5000'
    if (value <= 10000) return 'chip-10000'
    return 'chip-high'
  }

  function cardColorClass(suit: Suit) {
    return suit === 'hearts' || suit === 'diamonds' ? 'red' : ''
  }

  function placeChip(value: number) {
    if (phase !== 'betting') return
    if (stagedBet + value > bankroll) return
    setChipStack((prev) => [...prev, value])
  }

  function removeLastChip() {
    if (phase !== 'betting') return
    setChipStack((prev) => prev.slice(0, -1))
  }

  function allIn() {
    if (phase !== 'betting') return
    if (bankroll <= 0) return
    setChipStack(stackForAmount(maxAffordableBet(bankroll)))
  }

  function setRoundPopup(summary: 'Win' | 'Lose' | 'Tie', details: string, gold = false) {
    setRoundSummary(summary)
    setRoundDetails(details)
    setRoundIsGold(gold)
  }

  function settleRound(nextHands: PlayerHand[], finalDealerCards: Card[], nextShoe: Card[]) {
    const dealerTotal = handTotals(finalDealerCards).best
    const dealerBust = dealerTotal > 21

    let payout = 0
    let wins = 0
    let losses = 0
    let pushes = 0

    const resolvedHands = nextHands.map((hand) => {
      if (hand.isBusted) {
        losses += 1
        return { ...hand, result: 'lose' as HandResult }
      }

      const playerTotal = handTotals(hand.cards).best

      if (dealerBust || playerTotal > dealerTotal) {
        payout += hand.bet * 2
        wins += 1
        return { ...hand, result: 'win' as HandResult }
      }

      if (playerTotal < dealerTotal) {
        losses += 1
        return { ...hand, result: 'lose' as HandResult }
      }

      payout += hand.bet
      pushes += 1
      return { ...hand, result: 'push' as HandResult }
    })

    setBankroll((prev) => prev + payout)
    setStats((prev) => ({
      rounds: prev.rounds + 1,
      wins: prev.wins + wins,
      losses: prev.losses + losses,
      pushes: prev.pushes + pushes,
    }))

    setHands(resolvedHands)
    setDealerCards(finalDealerCards)
    setShoe(nextShoe)
    setPhase('roundOver')
    setDealerHoleRevealed(true)
    setDealerIsThinking(false)

    const reasonByHand = resolvedHands.map((hand) => {
      if (hand.isBusted) return 'Player Bust'
      const playerTotal = handTotals(hand.cards).best
      if (dealerBust) return 'Dealer Bust'
      if (playerTotal > dealerTotal) return 'Higher Total'
      if (playerTotal < dealerTotal) return 'Lower Total'
      return 'Push'
    })
    const details =
      reasonByHand.length === 1
        ? reasonByHand[0]
        : reasonByHand.map((reason, index) => `Hand ${index + 1}: ${reason}`).join(' • ')

    if (wins > losses) {
      setStatus('Round complete: you came out ahead.')
      setRoundPopup('Win', details)
    } else if (wins < losses) {
      setStatus('Round complete: dealer had the edge.')
      setRoundPopup('Lose', details)
    } else {
      setStatus('Round complete: mostly even.')
      setRoundPopup('Tie', details)
    }
  }

  async function runDealerTurn(nextHands: PlayerHand[], startDealerCards: Card[], startShoe: Card[]) {
    let nextDealerCards = [...startDealerCards]
    let nextShoe = [...startShoe]
    setDealerIsThinking(true)
    setStatus('Dealer checks the hole card...')
    await wait(DEALER_REVEAL_DELAY_MS)
    setDealerHoleRevealed(true)
    await wait(500)

    while (true) {
      const totals = handTotals(nextDealerCards)
      const shouldHit =
        totals.best < 17 || (DEALER_HITS_SOFT_17 && totals.best === 17 && totals.isSoft)
      if (!shouldHit) break
      setStatus('Dealer draws...')
      await wait(DEALER_DRAW_DELAY_MS)
      const draw = drawCard(nextShoe)
      nextDealerCards = [...nextDealerCards, draw.card]
      nextShoe = draw.nextShoe
      setDealerCards(nextDealerCards)
    }

    setStatus('Dealer stands. Settling bets...')
    await wait(500)
    settleRound(nextHands, nextDealerCards, nextShoe)
  }

  function progressToNextHand(nextHands: PlayerHand[], nextDealerCards: Card[], nextShoe: Card[]) {
    const nextIndex = nextHands.findIndex((hand, index) => index > currentHand && !hand.isDone)

    if (nextIndex === -1) {
      const allHandsBusted = nextHands.every((hand) => hand.isBusted)
      setHands(nextHands)
      setDealerCards(nextDealerCards)
      setShoe(nextShoe)

      if (allHandsBusted) {
        settleRound(nextHands, nextDealerCards, nextShoe)
        return
      }

      setPhase('dealerTurn')
      void runDealerTurn(nextHands, nextDealerCards, nextShoe)
      return
    }

    setHands(nextHands)
    setDealerCards(nextDealerCards)
    setShoe(nextShoe)
    setCurrentHand(nextIndex)
  }

  async function startRound() {
    const bet = stagedBet
    if (phase !== 'betting') return
    if (bet < MIN_BET) {
      setStatus(`Minimum bet is $${MIN_BET}.`)
      return
    }
    if (bet > bankroll) {
      setStatus('Insufficient bankroll for that wager.')
      return
    }

    let nextShoe = ensureShoeHasCards(shoe)
    setPhase('dealing')
    setStatus('Dealing...')
    setBetPotChips(chipStack)
    setChipStack([])
    setLastRoundBet(bet)
    setBankroll((prev) => prev - bet)
    setHands([])
    setDealerCards([])
    setDealerHoleRevealed(false)
    setDealerIsThinking(false)
    setRoundPopup('Tie', '', false)
    setCurrentHand(0)

    const p1 = drawCard(nextShoe)
    nextShoe = p1.nextShoe
    setHands([createHand([p1.card], bet)])
    await wait(INITIAL_DEAL_DELAY_MS)

    const d1 = drawCard(nextShoe)
    nextShoe = d1.nextShoe
    setDealerCards([d1.card])
    await wait(INITIAL_DEAL_DELAY_MS)

    const p2 = drawCard(nextShoe)
    nextShoe = p2.nextShoe
    const playerHand = createHand([p1.card, p2.card], bet)
    setHands([playerHand])
    await wait(INITIAL_DEAL_DELAY_MS)

    const d2 = drawCard(nextShoe)
    nextShoe = d2.nextShoe
    const nextDealerCards = [d1.card, d2.card]
    setDealerCards(nextDealerCards)
    setShoe(nextShoe)

    const dealerBJ = isBlackjack(nextDealerCards)
    const playerBJ = playerHand.isBlackjack

    if (dealerBJ || playerBJ) {
      setPhase('roundOver')
      setDealerHoleRevealed(true)
      setDealerIsThinking(false)

      if (dealerBJ && playerBJ) {
        setHands([{ ...playerHand, result: 'push', isDone: true }])
        setBankroll((prev) => prev + bet)
        setStats((prev) => ({
          rounds: prev.rounds + 1,
          wins: prev.wins,
          losses: prev.losses,
          pushes: prev.pushes + 1,
        }))
        setStatus('Both blackjack: push.')
        setRoundPopup('Tie', 'Double Natural Blackjack', true)
      } else if (playerBJ) {
        setHands([{ ...playerHand, result: 'win', isDone: true }])
        setBankroll((prev) => prev + bet + bet * (1 + BLACKJACK_PAYOUT))
        setStats((prev) => ({
          rounds: prev.rounds + 1,
          wins: prev.wins + 1,
          losses: prev.losses,
          pushes: prev.pushes,
        }))
        setStatus('Blackjack pays 3:2.')
        setRoundPopup('Win', 'Natural Blackjack')
      } else {
        setHands([{ ...playerHand, result: 'lose', isDone: true }])
        setStats((prev) => ({
          rounds: prev.rounds + 1,
          wins: prev.wins,
          losses: prev.losses + 1,
          pushes: prev.pushes,
        }))
        setStatus('Dealer blackjack.')
        setRoundPopup('Lose', 'Dealer Blackjack')
      }

      return
    }

    setPhase('playerTurn')
    setStatus('Your turn.')
  }

  function hit() {
    if (phase !== 'playerTurn') return

    const hand = hands[currentHand]
    if (!hand || hand.isDone) return

    let nextShoe = [...shoe]
    const draw = drawCard(nextShoe)
    nextShoe = draw.nextShoe

    const nextCards = [...hand.cards, draw.card]
    const total = handTotals(nextCards).best

    const updatedHand: PlayerHand = {
      ...hand,
      cards: nextCards,
      isBusted: total > 21,
      isDone: total > 21 || (hand.isSplitAces && nextCards.length >= 2),
    }

    const nextHands = hands.map((h, idx) => (idx === currentHand ? updatedHand : h))

    if (updatedHand.isDone) {
      progressToNextHand(nextHands, dealerCards, nextShoe)
    } else {
      setHands(nextHands)
      setShoe(nextShoe)
    }
  }

  function stand() {
    if (phase !== 'playerTurn') return

    const hand = hands[currentHand]
    if (!hand || hand.isDone) return

    const updatedHand: PlayerHand = {
      ...hand,
      isDone: true,
      isStanding: true,
    }

    const nextHands = hands.map((h, idx) => (idx === currentHand ? updatedHand : h))
    progressToNextHand(nextHands, dealerCards, shoe)
  }

  function doubleDown() {
    if (phase !== 'playerTurn') return

    const hand = hands[currentHand]
    if (!hand || hand.isDone || hand.cards.length !== 2 || bankroll < hand.bet) return

    let nextShoe = [...shoe]
    const draw = drawCard(nextShoe)
    nextShoe = draw.nextShoe

    const doubledBet = hand.bet * 2
    const nextCards = [...hand.cards, draw.card]
    const total = handTotals(nextCards).best

    const updatedHand: PlayerHand = {
      ...hand,
      cards: nextCards,
      bet: doubledBet,
      isDoubled: true,
      isDone: true,
      isStanding: total <= 21,
      isBusted: total > 21,
    }

    setBankroll((prev) => prev - hand.bet)

    const nextHands = hands.map((h, idx) => (idx === currentHand ? updatedHand : h))
    progressToNextHand(nextHands, dealerCards, nextShoe)
  }

  function split() {
    if (phase !== 'playerTurn') return

    const hand = hands[currentHand]
    if (!hand || hand.isDone || !canSplit(hand) || bankroll < hand.bet) return

    let nextShoe = [...shoe]
    const firstSplitAces = hand.cards[0].rank === 'A'

    const firstDraw = drawCard(nextShoe)
    nextShoe = firstDraw.nextShoe
    const secondDraw = drawCard(nextShoe)
    nextShoe = secondDraw.nextShoe

    const firstHand = createHand([hand.cards[0], firstDraw.card], hand.bet, firstSplitAces)
    const secondHand = createHand([hand.cards[1], secondDraw.card], hand.bet, firstSplitAces)

    if (firstSplitAces) {
      firstHand.isDone = true
      firstHand.isStanding = true
      secondHand.isDone = true
      secondHand.isStanding = true
    }

    const nextHands = [
      ...hands.slice(0, currentHand),
      firstHand,
      secondHand,
      ...hands.slice(currentHand + 1),
    ]

    setBankroll((prev) => prev - hand.bet)

    if (firstSplitAces) {
      setHands(nextHands)
      setCurrentHand(currentHand)
      setPhase('dealerTurn')
      void runDealerTurn(nextHands, dealerCards, nextShoe)
      return
    }

    setHands(nextHands)
    setCurrentHand(currentHand)
    setShoe(nextShoe)
  }

  function clearForNextRound() {
    const affordable = maxAffordableBet(bankroll)
    const targetBet = Math.min(lastRoundBet, affordable)
    setHands([])
    setDealerCards([])
    setBetPotChips([])
    setChipStack(targetBet > 0 ? stackForAmount(targetBet) : [])
    setCurrentHand(0)
    setPhase('betting')
    setStatus('Place your bet to begin.')
    setDealerHoleRevealed(false)
    setDealerIsThinking(false)
    setRoundPopup('Tie', '', false)
  }

  function resetBankroll() {
    if (phase !== 'betting') return
    const resetBank = 1000
    const resetLastBet = 100
    setBankroll(resetBank)
    setLastRoundBet(resetLastBet)
    const affordable = maxAffordableBet(resetBank)
    const targetBet = Math.min(resetLastBet, affordable)
    setChipStack(targetBet > 0 ? stackForAmount(targetBet) : [])
    setBetPotChips([])
    setStatus('Bankroll reset to $1,000.')
  }

  const activeHand = hands[currentHand]
  const canHitNow = phase === 'playerTurn' && Boolean(activeHand && !activeHand.isDone)
  const canStandNow = canHitNow
  const canDoubleNow =
    canHitNow && Boolean(activeHand && activeHand.cards.length === 2 && bankroll >= activeHand.bet)
  const canSplitNow = canHitNow && Boolean(activeHand && canSplit(activeHand) && bankroll >= activeHand.bet)
  const hasActiveHands = hands.length > 0

  return (
    <main className="app">
      <section className={`table-shell ${hasActiveHands ? '' : 'no-hand'}`} aria-label="Blackjack table">
        <header className="table-header">
          <h1>Blackjack Simulator</h1>
          <p>Client-side demo for educational use only.</p>
        </header>
        <div className="top-right-reset">
          <button type="button" onClick={resetBankroll} disabled={phase !== 'betting'}>
            Reset Bankroll
          </button>
        </div>

        <section className="stats-row">
          <div>Phase: {phase}</div>
          <div>Rounds: {stats.rounds}</div>
          <div>Wins: {stats.wins}</div>
          <div>Losses: {stats.losses}</div>
          <div>Pushes: {stats.pushes}</div>
        </section>

        <section className={`dealer-area dealer-lane ${dealerIsThinking ? 'thinking' : ''}`}>
          <h2>Dealer</h2>
          <p className="hand-total">Total: {dealerTotalText}</p>
          <div className="cards">
            {dealerCards.map((card, index) => {
              const hidden = !dealerVisible && index === 1
              return (
                <article className={`playing-card ${hidden ? 'hidden' : ''}`} key={card.id}>
                  {hidden ? (
                    <span>Hidden</span>
                  ) : (
                    <>
                      <span className={`top ${cardColorClass(card.suit)}`}>
                        {card.rank + SUIT_SYMBOL[card.suit]}
                      </span>
                      <span className={`center ${cardColorClass(card.suit)}`}>
                        {SUIT_SYMBOL[card.suit]}
                      </span>
                      <span className={`bottom ${cardColorClass(card.suit)}`}>
                        {card.rank + SUIT_SYMBOL[card.suit]}
                      </span>
                    </>
                  )}
                </article>
              )
            })}
          </div>
        </section>

        {phase === 'betting' ? (
          <section className="bet-pit mid-lane">
            <h2>Current Bet</h2>
            <p className="pot-total">${tableBet.toFixed(0)}</p>
            <p className="chip-tower-label">Click stack to remove the last chip before deal.</p>
            <button
              type="button"
              className="chip-tower center-pot center-pot-button"
              onClick={removeLastChip}
              disabled={chipStack.length === 0}
              aria-live="polite"
            >
              {typeof topPotChip !== 'number' ? (
                <span className="tower-empty">No chips in play</span>
              ) : (
                <>
                  <span className={`chip chip-stack ${chipClass(topPotChip)}`}>
                    <span>${topPotChip}</span>
                  </span>
                  <span className="stack-count">{displayedPot.length} chips</span>
                </>
              )}
            </button>
          </section>
        ) : (
          <section className="live-bet-strip mid-lane" aria-label="Current bet in play">
            <div className="chip-tower center-pot live-pot" aria-live="polite">
              {typeof topPotChip === 'number' ? (
                <span className={`chip chip-stack ${chipClass(topPotChip)}`}>
                  <span>${topPotChip}</span>
                </span>
              ) : (
                <span className="tower-empty">No chips</span>
              )}
            </div>
            <p className="live-bet-value">${tableBet.toFixed(0)}</p>
          </section>
        )}

        {hasActiveHands ? (
          <section className="player-area player-lane">
            <h2>Player</h2>
            <div className="player-battle-layout">
              <div className="side-actions left">
                {phase === 'playerTurn' ? (
                  <button className="action-button" type="button" onClick={stand} disabled={!canStandNow}>
                    Stand
                  </button>
                ) : null}
              </div>

              <div className="hands-grid">
                {hands.map((hand, idx) => {
                  const totals = handTotals(hand.cards)
                  const isCurrent = phase === 'playerTurn' && idx === currentHand
                  const resultText = hand.result ? hand.result.toUpperCase() : ''
                  return (
                    <article
                      className={`hand-panel ${isCurrent ? 'active' : ''} ${hand.result ?? ''}`}
                      key={`${idx}-${hand.cards.map((card) => card.id).join('-')}`}
                    >
                      <div className="hand-meta">
                        <span>Hand {idx + 1}</span>
                        <span>Bet: ${hand.bet}</span>
                        <span>Total: {totals.best}</span>
                      </div>
                      <div className="cards">
                        {hand.cards.map((card) => (
                          <article className="playing-card" key={card.id}>
                            <span className={`top ${cardColorClass(card.suit)}`}>
                              {card.rank + SUIT_SYMBOL[card.suit]}
                            </span>
                            <span className={`center ${cardColorClass(card.suit)}`}>
                              {SUIT_SYMBOL[card.suit]}
                            </span>
                            <span className={`bottom ${cardColorClass(card.suit)}`}>
                              {card.rank + SUIT_SYMBOL[card.suit]}
                            </span>
                          </article>
                        ))}
                      </div>
                      <div className="outcome">
                        {hand.isBlackjack && !hand.result ? 'Blackjack' : ''}
                        {hand.isBusted ? 'BUST' : ''}
                        {resultText}
                      </div>
                    </article>
                  )
                })}
              </div>

              <div className="side-actions right">
                {phase === 'playerTurn' ? (
                  <>
                    <button className="action-button" type="button" onClick={hit} disabled={!canHitNow}>
                      Hit
                    </button>
                    <button className="action-button" type="button" onClick={doubleDown} disabled={!canDoubleNow}>
                      Double
                    </button>
                    <button className="action-button" type="button" onClick={split} disabled={!canSplitNow}>
                      Split
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section className="controls controls-lane">
          <div className="bank-display">Bank: ${bankroll.toFixed(0)}</div>
          <div className="bet-controls">
            {availableChips.map((value) => (
              <button
                type="button"
                className={`chip chip-${value}`}
                key={value}
                onClick={() => placeChip(value)}
                disabled={phase !== 'betting'}
              >
                <span>${value}</span>
              </button>
            ))}
            <button
              type="button"
              className="chip chip-all-in"
              onClick={allIn}
              disabled={phase !== 'betting' || bankroll <= 0}
            >
              <span>All in</span>
            </button>
          </div>

          <div className="controls-bottom">
            <div className="reset-slot" />

            <div className="deal-slot">
              {phase === 'betting' ? (
                <button type="button" onClick={startRound} disabled={stagedBet < MIN_BET}>
                  Deal
                </button>
              ) : (
                <span className="deal-slot-spacer" aria-hidden="true" />
              )}
            </div>

            <div />
          </div>
        </section>

        {phase === 'roundOver' ? (
          <div className="round-popup-overlay" role="dialog" aria-modal="true" aria-label="Round result">
            <div className={`round-popup ${roundIsGold ? 'gold' : ''}`}>
              <h3>{roundSummary || 'Tie'}</h3>
              <p>{roundDetails || 'Push'}</p>
              <button type="button" onClick={clearForNextRound}>
                Next Round
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

function MultiplayerLobby({ onBackToMenu }: { onBackToMenu: () => void }) {
  const [name, setName] = useState(() => window.localStorage.getItem(MP_NAME_STORAGE_KEY) ?? '')
  const [playerId, setPlayerId] = useState('')
  const [playerToken, setPlayerToken] = useState('')
  const [myName, setMyName] = useState('')
  const [players, setPlayers] = useState<LobbyPlayer[]>([])
  const [gameState, setGameState] = useState<MultiplayerState | null>(null)
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deviceId] = useState(() => getDeviceId())
  const [triedAutoJoin, setTriedAutoJoin] = useState(false)

  async function fetchLobby() {
    const res = await fetch(`${SERVER_URL}/api/lobby`)
    if (!res.ok) throw new Error('Failed to load lobby.')
    const data: LobbyResponse = await res.json()
    setPlayers(data.players)
  }

  async function fetchGame(nextPlayerId = playerId, nextToken = playerToken) {
    if (!nextPlayerId || !nextToken) return
    const res = await fetch(
      `${SERVER_URL}/api/game/state?playerId=${encodeURIComponent(nextPlayerId)}&token=${encodeURIComponent(nextToken)}`,
    )
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Game API not found. Please restart backend server.')
      }
      throw new Error(`Failed to load game state (${res.status}).`)
    }
    const data: MultiplayerState = await res.json()
    setGameState(data)
  }

  async function pingPresence(nextPlayerId = playerId, nextToken = playerToken) {
    if (!nextPlayerId || !nextToken) return
    await fetch(`${SERVER_URL}/api/lobby/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: nextPlayerId, token: nextToken }),
    })
  }

  async function postGame(path: string, body: Record<string, unknown>) {
    if (!playerId || !playerToken) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${SERVER_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, token: playerToken, ...body }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? 'Action failed.')
      }
      setGameState(data)
      await fetchLobby()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void fetchLobby().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!playerId) return
    const id = setInterval(() => {
      void fetchLobby().catch(() => undefined)
      void fetchGame().catch(() => undefined)
      void pingPresence().catch(() => undefined)
    }, 2500)
    return () => clearInterval(id)
  }, [playerId, playerToken])

  async function joinLobby(overrideName?: string, silent = false) {
    const trimmed = (overrideName ?? name).trim()
    if (!trimmed && !silent) {
      setError('Please enter a name.')
      return
    }
    setJoining(true)
    if (!silent) setError('')
    try {
      const res = await fetch(`${SERVER_URL}/api/lobby/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, deviceId }),
      })
      const data: JoinLobbyResponse | { error?: string } = await res.json()
      if (!res.ok) {
        throw new Error(('error' in data ? data.error : undefined) ?? 'Could not join lobby.')
      }
      if (!('player' in data)) {
        throw new Error('Invalid join response.')
      }
      setPlayerId(data.player.id)
      setPlayerToken(data.token)
      setMyName(data.player.name)
      setName(data.player.name)
      setPlayers(data.players)
      window.localStorage.setItem(MP_NAME_STORAGE_KEY, data.player.name)
      try {
        await fetchGame(data.player.id, data.token)
      } catch (stateErr) {
        if (!silent) {
          setError(stateErr instanceof Error ? stateErr.message : 'Failed to load game state.')
        }
      }
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Could not join lobby.')
      }
    } finally {
      setJoining(false)
    }
  }

  async function leaveLobby() {
    if (!playerId) return
    try {
      await fetch(`${SERVER_URL}/api/lobby/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, token: playerToken }),
      })
    } finally {
      setPlayerId('')
      setPlayerToken('')
      setMyName('')
      setGameState(null)
      setError('')
      setName('')
      window.localStorage.removeItem(MP_NAME_STORAGE_KEY)
      void fetchLobby().catch(() => undefined)
      onBackToMenu()
    }
  }

  useEffect(() => {
    if (playerId || joining || triedAutoJoin) return
    setTriedAutoJoin(true)
    const rememberedName = window.localStorage.getItem(MP_NAME_STORAGE_KEY) ?? ''
    if (!rememberedName) {
      void joinLobby('', true)
      return
    }
    void joinLobby(rememberedName, true)
  }, [playerId, joining, triedAutoJoin])

  const mpPlayers = gameState?.players ?? []
  const me = mpPlayers.find((p) => p.id === playerId)
  const myBet = me?.bet ?? 0
  const myBetStack = me?.betStack ?? []
  const myCards = me?.cards ?? []
  const canAfford = (chip: number) => (me ? myBet + chip <= me.bank : false)
  const chipClass = (value: number) => {
    if (value <= 5) return 'chip-5'
    if (value <= 50) return 'chip-50'
    if (value <= 100) return 'chip-100'
    if (value <= 500) return 'chip-500'
    if (value <= 1000) return 'chip-1000'
    if (value <= 5000) return 'chip-5000'
    if (value <= 10000) return 'chip-10000'
    return 'chip-high'
  }
  const isMyTurn = gameState?.phase === 'playerTurn' && gameState.currentTurnPlayerId === playerId
  const canDouble = isMyTurn && myCards.length === 2 && Boolean(me && me.bank >= myBet)
  const iAmReady = Boolean(me?.ready)
  const dealerVisible = Boolean(gameState?.dealerRevealed || gameState?.phase === 'roundOver')
  const mpCardClass = (suit: Suit) => (suit === 'hearts' || suit === 'diamonds' ? 'red' : '')

  if (!playerId) {
    return (
      <main className="mode-screen">
        <section className="mode-card multiplayer">
          <h1>Multiplayer Lobby</h1>
          <p>Enter your name and join the single shared lobby. Everyone starts with $1000.</p>
          <div className="lobby-form">
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={24}
              placeholder="Your name"
            />
            <button type="button" onClick={() => void joinLobby()} disabled={joining}>
              {joining ? 'Joining...' : 'Join Lobby'}
            </button>
            <button type="button" onClick={onBackToMenu} disabled={joining}>
              Back
            </button>
          </div>
          {error ? <p className="lobby-error">{error}</p> : null}

          <div className="lobby-list">
            <h2>Players in Lobby ({players.length})</h2>
            {players.length === 0 ? <p>No players yet.</p> : null}
            {players.map((player) => (
              <div className="lobby-player" key={player.id}>
                <span>{player.name}</span>
                <span>${player.bank}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    )
  }

  const activeHand = me?.hands?.[me.currentHandIndex] ?? null
  const canSplit =
    isMyTurn &&
    Boolean(
      activeHand &&
        activeHand.cards.length === 2 &&
        activeHand.cards[0].rank === activeHand.cards[1].rank &&
        me &&
        me.bank >= activeHand.bet,
    )
  const roundSummary =
    me?.result === 'win' ? 'Win' : me?.result === 'lose' ? 'Lose' : me?.result === 'push' || me?.result === 'tie' ? 'Tie' : 'Tie'
  const roundDetails = me?.resultReason || 'Push'
  const roundIsGold = roundDetails.includes('Double Natural Blackjack')

  return (
    <main className="app">
      <section className={`table-shell ${myCards.length > 0 ? '' : 'no-hand'}`} aria-label="Blackjack multiplayer table">
        <header className="table-header">
          <h1>Blackjack Multiplayer</h1>
          <p>Joined as {myName} | {gameState?.message ?? 'Loading...'}</p>
        </header>

        <div className="top-right-reset">
          <button type="button" onClick={leaveLobby}>
            Leave Lobby
          </button>
        </div>

        <section className="stats-row">
          <div>Phase: {gameState?.phase ?? '--'}</div>
          <div>Players: {mpPlayers.length}</div>
          <div>Turn: {gameState?.currentTurnPlayerId === playerId ? 'You' : mpPlayers.find((p) => p.id === gameState?.currentTurnPlayerId)?.name ?? '-'}</div>
          <div>Your Bank: ${me?.bank ?? 0}</div>
          <div>Your Bet: ${myBet}</div>
        </section>

        <section className="dealer-area dealer-lane">
          <h2>Dealer</h2>
          <div className="cards">
                {(gameState?.dealerCards ?? []).map((card, index) => {
                  const hidden = 'hidden' in card || (!dealerVisible && index === 1)
                  return (
                    <article className={`playing-card ${hidden ? 'hidden' : ''}`} key={card.id}>
                      {hidden ? (
                        <span>Hidden</span>
                      ) : (
                        <>
                          {'hidden' in card ? null : (
                            <>
                              <span className={`top ${mpCardClass(card.suit)}`}>{card.rank + SUIT_SYMBOL[card.suit]}</span>
                              <span className={`center ${mpCardClass(card.suit)}`}>{SUIT_SYMBOL[card.suit]}</span>
                              <span className={`bottom ${mpCardClass(card.suit)}`}>{card.rank + SUIT_SYMBOL[card.suit]}</span>
                            </>
                          )}
                        </>
                      )}
                    </article>
                  )
                })}
          </div>
        </section>

        {gameState?.phase === 'betting' ? (
          <section className="bet-pit mid-lane">
            <h2>Current Bet</h2>
            <p className="pot-total">${myBet.toFixed(0)}</p>
            <button
              type="button"
              className="chip-tower center-pot center-pot-button"
              onClick={() => void postGame('/api/game/bet/undo', {})}
              disabled={busy || iAmReady || myBetStack.length === 0}
            >
              {myBetStack.length === 0 ? (
                <span className="tower-empty">No chips in play</span>
              ) : (
                <>
                  <span className={`chip chip-stack ${chipClass(myBetStack[myBetStack.length - 1])}`}>
                    <span>${myBetStack[myBetStack.length - 1]}</span>
                  </span>
                  <span className="stack-count">{myBetStack.length} chips</span>
                </>
              )}
            </button>
          </section>
        ) : (
          <section className="live-bet-strip mid-lane">
            <div className="chip-tower center-pot live-pot">
              <span className={`chip chip-stack ${chipClass(myBet > 0 ? myBet : 5)}`}>
                <span>${myBet}</span>
              </span>
            </div>
            <p className="live-bet-value">${myBet.toFixed(0)}</p>
          </section>
        )}

        <section className="player-area player-lane">
          <h2>Your Hands</h2>
          <div className="player-battle-layout">
            <div className="side-actions left">
              {gameState?.phase === 'playerTurn' ? (
                <button className="action-button" type="button" onClick={() => void postGame('/api/game/action', { action: 'stand' })} disabled={!isMyTurn || busy}>
                  Stand
                </button>
              ) : null}
            </div>

            <div className="hands-grid">
              {me?.hands?.map((hand, idx) => (
                <article className={`hand-panel ${idx === (me?.currentHandIndex ?? -1) && isMyTurn ? 'active' : ''}`} key={`${idx}-${hand.cards.map((c) => c.id).join('-')}`}>
                  <div className="hand-meta">
                    <span>Hand {idx + 1}</span>
                    <span>Bet: ${hand.bet}</span>
                    <span>Total: {handTotals(hand.cards).best}</span>
                  </div>
                  <div className="cards">
                    {hand.cards.map((card) => (
                      <article className="playing-card" key={card.id}>
                        <span className={`top ${mpCardClass(card.suit)}`}>{card.rank + SUIT_SYMBOL[card.suit]}</span>
                        <span className={`center ${mpCardClass(card.suit)}`}>{SUIT_SYMBOL[card.suit]}</span>
                        <span className={`bottom ${mpCardClass(card.suit)}`}>{card.rank + SUIT_SYMBOL[card.suit]}</span>
                      </article>
                    ))}
                  </div>
                  {hand.result ? <div className="outcome">{hand.result.toUpperCase()} - {hand.resultReason}</div> : null}
                </article>
              ))}
            </div>

            <div className="side-actions right">
              {gameState?.phase === 'playerTurn' ? (
                <>
                  <button className="action-button" type="button" onClick={() => void postGame('/api/game/action', { action: 'hit' })} disabled={!isMyTurn || busy}>
                    Hit
                  </button>
                  <button className="action-button" type="button" onClick={() => void postGame('/api/game/action', { action: 'double' })} disabled={!canDouble || busy}>
                    Double
                  </button>
                  <button className="action-button" type="button" onClick={() => void postGame('/api/game/action', { action: 'split' })} disabled={!canSplit || busy}>
                    Split
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </section>

        <section className="controls controls-lane">
          <div className="bank-display">Bank: ${me?.bank ?? 0}</div>
          <div className="bet-controls">
            {CHIP_VALUES.filter((chip) => canAfford(chip)).map((chip) => (
              <button
                key={chip}
                type="button"
                className={`chip chip-${chip}`}
                onClick={() => void postGame('/api/game/bet/chip', { chip })}
                disabled={gameState?.phase !== 'betting' || iAmReady || busy}
              >
                <span>${chip}</span>
              </button>
            ))}
            <button type="button" className="chip chip-all-in" onClick={() => void postGame('/api/game/bet/allin', {})} disabled={gameState?.phase !== 'betting' || iAmReady || busy}>
              <span>All in</span>
            </button>
          </div>

          <div className="controls-bottom">
            <div className="reset-slot" />
            <div className="deal-slot">
              {gameState?.phase === 'betting' ? (
                <button type="button" onClick={() => void postGame('/api/game/ready', {})} disabled={busy || myBet < MIN_BET}>
                  {iAmReady ? 'Unready' : 'Ready'}
                </button>
              ) : (
                <span className="deal-slot-spacer" aria-hidden="true" />
              )}
            </div>
            <div />
          </div>
        </section>

        <section className="mp-players">
          {mpPlayers.filter((p) => p.id !== playerId).map((player) => (
            <article className="mp-player" key={player.id}>
              <p>
                <strong>{player.name}</strong> | Bank: ${player.bank} | Bet: ${player.bet}
                {player.ready ? ' | Ready' : ''}
                {gameState?.currentTurnPlayerId === player.id ? ' | Turn' : ''}
              </p>
              <div className="cards">
                {player.hands.flatMap((h) => h.cards).map((card) => (
                  <article className="playing-card small" key={card.id}>
                    <span className={`top ${mpCardClass(card.suit)}`}>{card.rank + SUIT_SYMBOL[card.suit]}</span>
                    <span className={`center ${mpCardClass(card.suit)}`}>{SUIT_SYMBOL[card.suit]}</span>
                    <span className={`bottom ${mpCardClass(card.suit)}`}>{card.rank + SUIT_SYMBOL[card.suit]}</span>
                  </article>
                ))}
              </div>
              {player.result ? <p>{player.result.toUpperCase()} - {player.resultReason}</p> : null}
            </article>
          ))}
        </section>

        {gameState?.phase === 'roundOver' ? (
          <div className="round-popup-overlay" role="dialog" aria-modal="true" aria-label="Round result">
            <div className={`round-popup ${roundIsGold ? 'gold' : ''}`}>
              <h3>{roundSummary}</h3>
              <p>{roundDetails}</p>
              <button type="button" onClick={() => void postGame('/api/game/next-round', {})} disabled={busy}>
                Next Round
              </button>
            </div>
          </div>
        ) : null}
        {error ? <p className="lobby-error">{error}</p> : null}
      </section>
    </main>
  )
}

function App() {
  const [mode, setMode] = useState<'menu' | 'single' | 'multi'>(() => {
    const saved = window.localStorage.getItem(MODE_STORAGE_KEY)
    if (saved === 'single' || saved === 'multi') return saved
    return 'menu'
  })

  function chooseMode(nextMode: 'menu' | 'single' | 'multi') {
    setMode(nextMode)
    window.localStorage.setItem(MODE_STORAGE_KEY, nextMode)
  }

  if (mode === 'single') return <SingleplayerGame />
  if (mode === 'multi') return <MultiplayerLobby onBackToMenu={() => chooseMode('menu')} />

  return (
    <main className="mode-screen">
      <section className="mode-card">
        <h1>Blackjack</h1>
        <p>Select how you want to play.</p>
        <div className="mode-actions">
          <button type="button" onClick={() => chooseMode('single')}>
            Singleplayer
          </button>
          <button type="button" onClick={() => chooseMode('multi')}>
            Multiplayer
          </button>
        </div>
      </section>
    </main>
  )
}

export default App
