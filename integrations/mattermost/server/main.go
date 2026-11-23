// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package main

import "github.com/mattermost/mattermost/server/public/plugin"

func main() {
	plugin.ClientMain(&Plugin{})
}
