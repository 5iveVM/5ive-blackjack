account BlackjackTable {
    authority: pubkey;
    min_bet: u64;
    max_bet: u64;
    dealer_soft17_hits: bool;
    round_nonce: u64;
}

account PlayerState {
    owner: pubkey;
    chips: u64;
    active_bet: u64;
    hand_total: u64;
    dealer_total: u64;
    round_status: u64;
    outcome: u64;
    in_round: bool;
}

account RoundState {
    deck_seed: u64;
    owner_marker: u64;
    draw_cursor: u64;
    player_card_count: u64;
    dealer_card_count: u64;
    player_soft_aces: u64;
    dealer_soft_aces: u64;
    player_stand: bool;
}

fn round_idle() -> u64 {
    return 0;
}

fn round_active() -> u64 {
    return 1;
}

fn round_player_bust() -> u64 {
    return 2;
}

fn round_dealer_bust() -> u64 {
    return 3;
}

fn round_player_win() -> u64 {
    return 4;
}

fn round_dealer_win() -> u64 {
    return 5;
}

fn round_push() -> u64 {
    return 6;
}

fn card_rank(seed: u64, cursor: u64, marker: u64) -> u64 {
    let mixed = seed + (cursor * 17) + (marker * 31) + 7;
    return (mixed % 13) + 1;
}

fn card_value(rank: u64) -> u64 {
    if rank == 1 {
        return 11;
    }
    if rank >= 10 {
        return 10;
    }
    return rank;
}

fn dealer_should_draw(total: u64, soft_aces: u64, dealer_soft17_hits: bool) -> bool {
    if total < 17 {
        return true;
    }

    if dealer_soft17_hits && total == 17 && soft_aces > 0 {
        return true;
    }

    return false;
}

pub init_table(
    table: BlackjackTable @mut,
    authority: account @signer,
    min_bet: u64,
    max_bet: u64,
    dealer_soft17_hits: bool
) {
    require(min_bet > 0);
    require(max_bet >= min_bet);

    table.authority = authority.ctx.key;
    table.min_bet = min_bet;
    table.max_bet = max_bet;
    table.dealer_soft17_hits = dealer_soft17_hits;
    table.round_nonce = 0;
}

pub init_player(
    player: PlayerState @mut,
    owner: account @signer,
    initial_chips: u64
) {
    require(initial_chips > 0);

    player.owner = owner.ctx.key;
    player.chips = initial_chips;
    player.active_bet = 0;
    player.hand_total = 0;
    player.dealer_total = 0;
    player.round_status = round_idle();
    player.outcome = round_idle();
    player.in_round = false;
}

pub start_round(
    table: BlackjackTable @mut,
    player: PlayerState @mut,
    round: RoundState @mut,
    owner: account @signer,
    bet: u64,
    seed: u64
) {
    require(player.owner == owner.ctx.key);
    require(!player.in_round);
    require(bet >= table.min_bet);
    require(bet <= table.max_bet);
    require(player.chips >= bet);

    table.round_nonce = table.round_nonce + 1;

    round.deck_seed = seed;
    round.owner_marker = table.round_nonce + bet + (seed % 97);
    round.draw_cursor = 0;
    round.player_card_count = 0;
    round.dealer_card_count = 0;
    round.player_soft_aces = 0;
    round.dealer_soft_aces = 0;
    round.player_stand = false;

    let mut player_total = 0;
    let mut dealer_total = 0;

    let rank_1 = card_rank(round.deck_seed, round.draw_cursor, round.owner_marker);
    let value_1 = card_value(rank_1);
    player_total = player_total + value_1;
    if rank_1 == 1 {
        round.player_soft_aces = round.player_soft_aces + 1;
    }
    while (player_total > 21 && round.player_soft_aces > 0) {
        player_total = player_total - 10;
        round.player_soft_aces = round.player_soft_aces - 1;
    }
    round.draw_cursor = round.draw_cursor + 1;
    round.player_card_count = round.player_card_count + 1;

    let rank_2 = card_rank(round.deck_seed, round.draw_cursor, round.owner_marker);
    let value_2 = card_value(rank_2);
    dealer_total = dealer_total + value_2;
    if rank_2 == 1 {
        round.dealer_soft_aces = round.dealer_soft_aces + 1;
    }
    while (dealer_total > 21 && round.dealer_soft_aces > 0) {
        dealer_total = dealer_total - 10;
        round.dealer_soft_aces = round.dealer_soft_aces - 1;
    }
    round.draw_cursor = round.draw_cursor + 1;
    round.dealer_card_count = round.dealer_card_count + 1;

    let rank_3 = card_rank(round.deck_seed, round.draw_cursor, round.owner_marker);
    let value_3 = card_value(rank_3);
    player_total = player_total + value_3;
    if rank_3 == 1 {
        round.player_soft_aces = round.player_soft_aces + 1;
    }
    while (player_total > 21 && round.player_soft_aces > 0) {
        player_total = player_total - 10;
        round.player_soft_aces = round.player_soft_aces - 1;
    }
    round.draw_cursor = round.draw_cursor + 1;
    round.player_card_count = round.player_card_count + 1;

    let rank_4 = card_rank(round.deck_seed, round.draw_cursor, round.owner_marker);
    let value_4 = card_value(rank_4);
    dealer_total = dealer_total + value_4;
    if rank_4 == 1 {
        round.dealer_soft_aces = round.dealer_soft_aces + 1;
    }
    while (dealer_total > 21 && round.dealer_soft_aces > 0) {
        dealer_total = dealer_total - 10;
        round.dealer_soft_aces = round.dealer_soft_aces - 1;
    }
    round.draw_cursor = round.draw_cursor + 1;
    round.dealer_card_count = round.dealer_card_count + 1;

    player.active_bet = bet;
    player.hand_total = player_total;
    player.dealer_total = dealer_total;
    player.round_status = round_active();
    player.outcome = round_active();
    player.in_round = true;
}

pub hit(
    player: PlayerState @mut,
    round: RoundState @mut,
    owner: account @signer
) {
    require(player.owner == owner.ctx.key);
    require(player.in_round);
    require(player.round_status == round_active());
    require(!round.player_stand);

    let rank = card_rank(round.deck_seed, round.draw_cursor, round.owner_marker);
    let value = card_value(rank);
    player.hand_total = player.hand_total + value;
    if rank == 1 {
        round.player_soft_aces = round.player_soft_aces + 1;
    }
    while (player.hand_total > 21 && round.player_soft_aces > 0) {
        player.hand_total = player.hand_total - 10;
        round.player_soft_aces = round.player_soft_aces - 1;
    }
    round.draw_cursor = round.draw_cursor + 1;
    round.player_card_count = round.player_card_count + 1;

    if player.hand_total > 21 {
        player.round_status = round_player_bust();
        player.outcome = round_dealer_win();
        player.chips = player.chips - player.active_bet;
        player.in_round = false;
    }
}

pub stand_and_settle(
    table: BlackjackTable,
    player: PlayerState @mut,
    round: RoundState @mut,
    owner: account @signer
) {
    require(player.owner == owner.ctx.key);
    require(player.in_round);
    require(player.round_status == round_active());

    round.player_stand = true;

    let mut dealer_total = player.dealer_total;
    let mut dealer_soft_aces = round.dealer_soft_aces;
    let mut dealer_cursor = round.draw_cursor;
    let mut dealer_guard = 0;

    while (dealer_should_draw(dealer_total, dealer_soft_aces, table.dealer_soft17_hits) && dealer_guard < 8) {
        let rank = card_rank(round.deck_seed, dealer_cursor, round.owner_marker);
        let value = card_value(rank);
        dealer_total = dealer_total + value;
        if rank == 1 {
            dealer_soft_aces = dealer_soft_aces + 1;
        }
        while (dealer_total > 21 && dealer_soft_aces > 0) {
            dealer_total = dealer_total - 10;
            dealer_soft_aces = dealer_soft_aces - 1;
        }
        dealer_cursor = dealer_cursor + 1;
        dealer_guard = dealer_guard + 1;
        round.dealer_card_count = round.dealer_card_count + 1;
    }

    round.dealer_soft_aces = dealer_soft_aces;
    round.draw_cursor = dealer_cursor;
    player.dealer_total = dealer_total;

    if dealer_total > 21 {
        player.round_status = round_dealer_bust();
        player.outcome = round_player_win();
        player.chips = player.chips + player.active_bet;
    } else if player.hand_total > dealer_total {
        player.round_status = round_player_win();
        player.outcome = round_player_win();
        player.chips = player.chips + player.active_bet;
    } else if player.hand_total < dealer_total {
        player.round_status = round_dealer_win();
        player.outcome = round_dealer_win();
        player.chips = player.chips - player.active_bet;
    } else {
        player.round_status = round_push();
        player.outcome = round_push();
    }

    player.in_round = false;
    player.active_bet = 0;
}

pub get_player_chips(player: PlayerState) -> u64 {
    return player.chips;
}

pub get_round_status(player: PlayerState) -> u64 {
    return player.round_status;
}

pub get_last_outcome(player: PlayerState) -> u64 {
    return player.outcome;
}
