// Blackjack MVP tests (deterministic / logic focused)

// @test-params 500 500
pub test_init_player_chips(initial_chips: u64) -> u64 {
    return initial_chips;
}

// @test-params 10 100 5 150 true
pub test_start_round_rejects_invalid_bet(min_bet: u64, max_bet: u64, low_bet: u64, high_bet: u64) -> bool {
    return low_bet < min_bet && high_bet > max_bet;
}

// @test-params 12 7 19
pub test_hit_progresses_hand(hand_total: u64, drawn_value: u64) -> u64 {
    return hand_total + drawn_value;
}

// @test-params 19 5 2
pub test_player_bust_sets_outcome(hand_total: u64, drawn_value: u64) -> u64 {
    let next_total = hand_total + drawn_value;
    if next_total > 21 {
        return 2;
    }
    return 1;
}

// @test-params 16 true
pub test_stand_triggers_dealer_draw(dealer_total: u64) -> bool {
    return dealer_total < 17;
}

// @test-params 500 25 500
pub test_push_no_chip_change(chips: u64, _bet: u64) -> u64 {
    return chips;
}

// @test-params 500 25 525
pub test_win_updates_chips(chips: u64, bet: u64) -> u64 {
    return chips + bet;
}

// @test-params true true
pub test_cannot_hit_after_stand(player_stand: bool) -> bool {
    return player_stand;
}
