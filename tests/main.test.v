// Tests for game template
// Test game logic

// @test-params 5 3 true
pub test_move_validation(x: u64, y: u64) -> bool {
    // Validate game world bounds
    let max_x = 100u64;
    let max_y = 100u64;
    return x < max_x && y < max_y;
}

// @test-params 1 100 101
pub test_level_up(level: u64, experience: u64) -> u64 {
    // Calculate experience needed for next level
    let required_exp = level * 100;
    if experience >= required_exp {
        return level + 1;
    }
    return level;
}
