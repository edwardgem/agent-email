#!/bin/bash

# Generic Email Sender Script
# Usage: ./mcp_email_sender.sh [options]

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/dev/null"  # No logging by default

# Default configuration (can be overridden by content config)
DEFAULT_SENDER_EMAIL="edwardgem@gmail.com"
DEFAULT_SENDER_NAME="Edward Cheng"

# Function to display usage
show_help() {
    cat << EOF
Generic Email Sender Script

Usage: $0 [OPTIONS]

OPTIONS:
    -c, --config <file>     Specify JSON config file (defaults to config.json)
    -g, --generate-only     Generate HTML file only (no email sending)
    -s, --send              Send email using generated HTML
    -f, --html-file <file>  Use existing HTML file for sending (skips generation)
    -o, --output <file>     Specify output HTML filename
    -h, --help              Show this help message

EXAMPLES:
    $0                                          Run with default config, generate HTML, and select options interactively
    $0 -g                                       Generate HTML only using default config
    $0 -s                                       Generate and send email using default config
    $0 -f my_email.html -s                      Send existing HTML file using default config
    $0 -c custom.json -g                        Generate HTML only with custom config
    $0 -c custom.json -s                        Generate and send email with custom config
    $0 -c custom.json -f existing.html -s       Send existing HTML file with custom config
    $0 -c custom.json -o custom.html -g         Generate with custom output name

NOTE:
    - Script uses Claude to generate HTML from the prompt in PROMPT_FILE (e.g. prompt.txt)
    - Update recipients and metadata in config.json (or your custom JSON)
    - Ensure you have Claude CLI and Gmail MCP server configured
EOF
}

require_jq() {
    if ! command -v jq >/dev/null 2>&1; then
        echo "❌ Error: 'jq' is required but not installed."
        echo "💡 Install jq (macOS: brew install jq, Ubuntu: sudo apt-get install jq)."
        exit 1
    fi
}

# Function to load configuration (JSON)
load_config() {
    local config_file="${1:-config.json}"

    if [[ ! -f "$config_file" ]]; then
        echo "❌ Error: Configuration file '$config_file' not found!"
        exit 1
    fi

    require_jq

    echo "📋 Loading configuration from: $config_file"

    # Read required + optional fields from JSON
    EMAIL_SUBJECT=$(jq -r '.email_subject // .EMAIL_SUBJECT // empty' "$config_file")
    SENDER_EMAIL=$(jq -r '.sender_email // .SENDER_EMAIL // empty' "$config_file")
    SENDER_NAME=$(jq -r '.sender_name // .SENDER_NAME // empty' "$config_file")
    HTML_OUTPUT=$(jq -r '.html_output // .HTML_OUTPUT // empty' "$config_file")
    PROMPT_FILE=$(jq -r '.prompt_file // .PROMPT_FILE // "prompt.txt"' "$config_file")

    # Defaults
    SENDER_EMAIL=${SENDER_EMAIL:-$DEFAULT_SENDER_EMAIL}
    SENDER_NAME=${SENDER_NAME:-$DEFAULT_SENDER_NAME}
    HTML_OUTPUT=${HTML_OUTPUT:-${config_file%.*}.html}

    # Recipient lists
    mapfile -t TO_LIST < <(jq -r '.to[]? // empty' "$config_file")
    mapfile -t CC_LIST < <(jq -r '.cc[]? // empty' "$config_file")
    mapfile -t BCC_LIST < <(jq -r '.bcc[]? // empty' "$config_file")

    # Validate required variables
    if [[ -z "$EMAIL_SUBJECT" ]]; then
        echo "❌ Error: email_subject (or EMAIL_SUBJECT) not defined in config file"
        exit 1
    fi
    
    # Validate prompt file
    if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
        echo "❌ Error: Prompt file not found: '${PROMPT_FILE}'"
        echo "💡 Set 'prompt_file' (or 'PROMPT_FILE') in config.json or place 'prompt.txt' in project root."
        exit 1
    fi

    echo "✅ Configuration loaded successfully"
    echo "   Subject: $EMAIL_SUBJECT"
    echo "   To: ${#TO_LIST[@]}  Cc: ${#CC_LIST[@]}  Bcc: ${#BCC_LIST[@]}"
    echo "   Output file: $HTML_OUTPUT"
    echo "   Prompt file: $PROMPT_FILE"
}

# Function to generate HTML content using Claude
generate_html() {
    local output_file="$1"
    local config_file="$2"  # kept for signature compatibility; not used for prompt now
    
    echo "🤖 Generating HTML content using Claude..."
    
    # Check if Claude CLI is available
    if ! command -v claude >/dev/null 2>&1; then
        echo "❌ Error: Claude CLI not found"
        echo "💡 Please install and configure Claude Code to use LLM-powered HTML generation"
        echo "   Visit: https://docs.anthropic.com/en/docs/claude-code"
        exit 1
    fi
    
    # Read the LLM prompt from PROMPT_FILE
    local llm_prompt
    llm_prompt=$(cat "$PROMPT_FILE")
    
    if [[ -z "$llm_prompt" ]]; then
        echo "❌ Error: Could not extract LLM prompt from config file"
        exit 1
    fi
    
    echo "📝 Loaded LLM prompt from: $PROMPT_FILE"
    echo "🔄 Calling Claude to generate HTML..."
    
    # Create temporary file for Claude's response
    local temp_response=$(mktemp)
    
    # Call Claude with a modified prompt to ensure HTML output
    local enhanced_prompt="$llm_prompt

IMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks. Do not include explanations, descriptions, or any text outside the HTML code block. The HTML should be complete and ready to use as email content."
    
    # Ensure output directory exists
    mkdir -p "$(dirname "$output_file")"

    if claude "$enhanced_prompt" > "$temp_response" 2>/dev/null; then
        # Extract HTML content from Claude's response
        # Look for HTML content between ```html and ``` or just take the response as-is
        if grep -q '```html' "$temp_response"; then
            # Extract HTML from code blocks
            sed -n '/```html/,/```/p' "$temp_response" | sed '1d;$d' > "$output_file"
        else
            # If no HTML code block found, check if the response looks like HTML
            if grep -q '<html\|<HTML\|<!DOCTYPE' "$temp_response"; then
                cat "$temp_response" > "$output_file"
            else
                echo "⚠️  Warning: Claude didn't return HTML code blocks. Trying to extract HTML..."
                # Try to find any HTML-like content
                if grep -q '<.*>' "$temp_response"; then
                    # Extract lines that contain HTML tags
                    grep '<.*>' "$temp_response" > "$output_file"
                else
                    # Last resort: take the entire response and warn the user
                    cat "$temp_response" > "$output_file"
                    echo "❌ Warning: No HTML content detected in Claude's response."
                    echo "💡 You may need to manually edit the output file: $output_file"
                fi
            fi
        fi
        
        rm -f "$temp_response"
        
        # Validate that we got some HTML content
        if [[ ! -s "$output_file" ]]; then
            echo "❌ Error: No HTML content generated by Claude"
            exit 1
        fi
        
        echo "✅ HTML file generated: $output_file"
        
        # Optionally open the generated HTML file in browser for review
        if [[ -z "$NO_OPEN" ]]; then
            echo "🌐 Opening HTML file in browser for review..."
            if command -v open >/dev/null 2>&1; then
                open "$output_file"
            elif command -v xdg-open >/dev/null 2>&1; then
                xdg-open "$output_file"
            else
                echo "📄 Please open $output_file in your browser to review."
            fi
        fi
        
    else
        echo "❌ Error: Claude call failed"
        echo "💡 Make sure you're authenticated with Claude and have proper access"
        rm -f "$temp_response"
        exit 1
    fi
}

# Function to send email via Claude MCP
send_email() {
    local html_file="$1"
    
    if [[ ! -f "$html_file" ]]; then
        echo "❌ Error: HTML file '$html_file' not found!"
        exit 1
    fi
    
    echo "📧 Preparing to send email..."
    echo "Subject: $EMAIL_SUBJECT"
    echo "From: $SENDER_NAME <$SENDER_EMAIL>"
    echo "To: ${#TO_LIST[@]} | Cc: ${#CC_LIST[@]} | Bcc: ${#BCC_LIST[@]}"
    echo
    
    # Show recipient list and validate
    if [[ ${#TO_LIST[@]} -eq 0 && ${#CC_LIST[@]} -eq 0 && ${#BCC_LIST[@]} -eq 0 ]]; then
        echo "❌ Error: No recipients configured (to/cc/bcc all empty)"
        exit 1
    fi
    echo "📋 Recipient List:"
    for i in "${!TO_LIST[@]}"; do echo "  To[$((i+1))]: ${TO_LIST[i]}"; done
    for i in "${!CC_LIST[@]}"; do echo "  Cc[$((i+1))]: ${CC_LIST[i]}"; done
    for i in "${!BCC_LIST[@]}"; do echo "  Bcc[$((i+1))]: ${BCC_LIST[i]}"; done
    echo
    
    # Confirmation prompt
    read -p "⚠️  Do you want to send this email to the listed recipients? (y/N): " confirm
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "❌ Email sending cancelled."
        exit 0
    fi
    
    # Read HTML content
    html_content=$(cat "$html_file")
    
    echo "🚀 Sending email..."
    echo "  📤 To: ${#TO_LIST[@]} | Cc: ${#CC_LIST[@]} | Bcc: ${#BCC_LIST[@]}"
    
    # Send email using Claude MCP Gmail integration
    echo "📡 Calling Gmail MCP service..."
    
    # Create a temporary file for the MCP call
    temp_json=$(mktemp)
    
    # Prepare recipient lists
    to_json=""; cc_json=""; bcc_json=""
    for i in "${!TO_LIST[@]}"; do
        if [[ $i -gt 0 ]]; then to_json+=","; fi
        to_json+="\"${TO_LIST[i]}\""
    done
    for i in "${!CC_LIST[@]}"; do
        if [[ $i -gt 0 ]]; then cc_json+=","; fi
        cc_json+="\"${CC_LIST[i]}\""
    done
    for i in "${!BCC_LIST[@]}"; do
        if [[ $i -gt 0 ]]; then bcc_json+=","; fi
        bcc_json+="\"${BCC_LIST[i]}\""
    done
    
    cat > "$temp_json" << EOF
{
    "to": [$to_json],
    "cc": [$cc_json],
    "bcc": [$bcc_json],
    "subject": "$EMAIL_SUBJECT",
    "htmlBody": $(echo "$html_content" | jq -Rs .),
    "mimeType": "text/html"
}
EOF
    
    # Execute the MCP call
    if command -v claude >/dev/null 2>&1; then
        echo "  📄 Sending via Claude MCP..."
        
        # Prepare recipients array for claude command
        # local bcc_recipients=""
        # for email in "${RECIPIENTS[@]}"; do
        #     if [[ -n "$bcc_recipients" ]]; then
        #         bcc_recipients+=", "
        #     fi
        #     bcc_recipients+="\"$email\""
        # done
        
        # Create the claude command to send email via MCP
        json_content=$(cat "$temp_json")
 
        #if claude --function-call mcp__server-gmail-autoauth-mcp__send_email --to "\"$SENDER_EMAIL\"" --bcc "[$bcc_recipients]" --subject "$EMAIL_SUBJECT" --htmlBody "$html_content" --mimeType "text/html" 2>$LOG_FILE; then
        if claude "Send email using gmail-mcp with this data: $json_content" 2>$LOG_FILE; then
            echo "  ✅ Email sent successfully!"
        else
            echo "  ❌ Error: MCP call failed. Please check authentication."
            echo "  💡 Make sure you're authenticated with Gmail via Claude MCP"
            echo "  📋 You can manually send with these parameters:"
            echo "      To: $(IFS=','; echo "${TO_LIST[*]}")"
            echo "      Cc: $(IFS=','; echo "${CC_LIST[*]}")"
            echo "      Bcc: $(IFS=','; echo "${BCC_LIST[*]}")"
            echo "      Subject: $EMAIL_SUBJECT"
            echo "      HTML Body: [content from $html_file]"
            rm -f "$temp_json"
            exit 1
        fi
    else
        echo "  ❌ Error: Claude CLI not found"
        echo "  💡 Please install Claude CLI or use the MCP parameters manually"
        echo "  📋 MCP Parameters:"
        cat "$temp_json"
    fi
    
    # Clean up
    rm -f "$temp_json"
    
    echo "✅ Email sending process completed!"
    echo "📊 Summary: Email sent"
}

# Function to validate recipients
validate_recipients() {
    local invalid_emails=()
    local all=("${TO_LIST[@]}" "${CC_LIST[@]}" "${BCC_LIST[@]}")
    for email in "${all[@]}"; do
        if [[ -n "$email" && ! "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
            invalid_emails+=("$email")
        fi
    done
    if [[ ${#invalid_emails[@]} -gt 0 ]]; then
        echo "⚠️  Warning: Invalid email addresses found:"
        for email in "${invalid_emails[@]}"; do
            echo "  - $email"
        done
        echo
        read -p "Continue anyway? (y/N): " confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Main script logic
main() {
    local generate_only=false
    local send_email_flag=false
    local config_file=""
    local output_file=""
    local html_file=""
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -c|--config)
                if [[ -n "$2" ]]; then
                    config_file="$2"
                    shift 2
                else
                    echo "❌ Error: --config requires a filename"
                    exit 1
                fi
                ;;
            -g|--generate-only)
                generate_only=true
                shift
                ;;
            -s|--send)
                send_email_flag=true
                shift
                ;;
            -f|--html-file)
                if [[ -n "$2" ]]; then
                    html_file="$2"
                    shift 2
                else
                    echo "❌ Error: --html-file requires a filename"
                    exit 1
                fi
                ;;
            -o|--output)
                if [[ -n "$2" ]]; then
                    output_file="$2"
                    shift 2
                else
                    echo "❌ Error: --output requires a filename"
                    exit 1
                fi
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                echo "❌ Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    # Set default config file if not specified
    if [[ -z "$config_file" ]]; then
        config_file="config.json"
        echo "📋 No config file specified, using default: $config_file"
    fi
    
    echo "🚀 Generic Email Generator & Sender"
    echo "=================================="
    echo
    
    # Load configuration
    load_config "$config_file"
    
    # Override output file if specified
    if [[ -n "$output_file" ]]; then
        HTML_OUTPUT="$output_file"
    fi
    
    # Use existing HTML file if specified
    if [[ -n "$html_file" ]]; then
        if [[ ! -f "$html_file" ]]; then
            echo "❌ Error: HTML file '$html_file' not found!"
            exit 1
        fi
        HTML_OUTPUT="$html_file"
        echo "📄 Using existing HTML file: $HTML_OUTPUT"
    fi
    
    # Validate recipients if sending email
    if [[ "$send_email_flag" == true ]]; then
        validate_recipients
    fi
    
    # Generate HTML
    if [[ "$generate_only" == true ]]; then
        if [[ -n "$html_file" ]]; then
            echo "❌ Error: Cannot use --generate-only with --html-file (existing file specified)"
            echo "💡 Use --html-file with --send to send the existing file, or remove --html-file to generate new content"
            exit 1
        fi
        generate_html "$HTML_OUTPUT" "$config_file"
        echo
        echo "📁 File saved to: $(pwd)/$HTML_OUTPUT"
        echo "🔍 You can now review and edit the HTML file before sending."
        echo
        echo "💡 To send the email later, use:"
        echo "   $0 --config $config_file --send"
        
    elif [[ "$send_email_flag" == true ]]; then
        # Check if HTML file exists, if not generate it (unless html_file is specified)
        if [[ -z "$html_file" && ! -f "$HTML_OUTPUT" ]]; then
            echo "📄 HTML file not found. Generating new file..."
            generate_html "$HTML_OUTPUT" "$config_file"
            echo
        fi
        send_email "$HTML_OUTPUT"
        
    else
        # Default: show interactive menu first
        echo "📁 Target HTML file: $HTML_OUTPUT"
        echo
        
        # Interactive menu loop
        while true; do
            echo "What would you like to do?"
            echo "1. Generate HTML (calls Claude to create email content)"
            echo "2. Use existing HTML file for sending"
            echo "3. Send email to recipients (generates HTML if needed)"
            echo "4. Exit"
            echo
            read -p "Enter your choice (1-4): " choice
            
            case $choice in
                1)
                    echo
                    generate_html "$HTML_OUTPUT" "$config_file"
                    echo
                    ;;
                2)
                    echo
                    read -p "Enter path to existing HTML file: " user_html_file
                    if [[ -z "$user_html_file" ]]; then
                        echo "❌ No file specified."
                        echo
                        continue
                    fi
                    if [[ ! -f "$user_html_file" ]]; then
                        echo "❌ Error: File '$user_html_file' not found!"
                        echo
                        continue
                    fi
                    HTML_OUTPUT="$user_html_file"
                    echo "✅ Using HTML file: $HTML_OUTPUT"
                    echo
                    ;;
                3)
                    # Check if HTML file exists, if not generate it
                    if [[ ! -f "$HTML_OUTPUT" ]]; then
                        echo "📄 HTML file not found. Generating new file..."
                        generate_html "$HTML_OUTPUT" "$config_file"
                        echo
                    fi
                    validate_recipients
                    send_email "$HTML_OUTPUT"
                    break
                    ;;
                4)
                    echo "👋 Goodbye!"
                    exit 0
                    ;;
                *)
                    echo "❌ Invalid choice. Please enter 1, 2, 3, or 4."
                    echo
                    ;;
            esac
        done
    fi
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
