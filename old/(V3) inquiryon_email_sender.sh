#!/bin/bash

# Generic Email Sender Script
# Usage: ./send_email.sh [options]

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
    -c, --config <file>     Specify email content configuration file (required)
    -g, --generate-only     Generate HTML file only (no email sending)
    -s, --send              Send email using generated HTML
    -o, --output <file>     Specify output HTML filename
    -h, --help              Show this help message

EXAMPLES:
    $0                                     Run the script, use default request config, and select options interactively
    $0 -c inquiryon_request.conf -g       Generate HTML only from a request-style config
    $0 -c inquiryon_request.conf -s       Generate and send email
    $0 -c my_event.conf -o custom.html -g Generate with custom output name

NOTE: 
    - Content configuration file is required
    - Update recipient list in the config file before sending
    - Ensure you have Claude MCP server access for Gmail
EOF
}

DEFAULT_CONFIG_FILE="inquiryon_request.conf"

# Function to generate HTML_CONTENT from a request-style config file
generate_from_request() {
    local reqfile="$1"

    # Read the request file and extract relevant sections
    if [[ ! -f "$reqfile" ]]; then
        echo "❌ Error: Request file '$reqfile' not found!"
        exit 1
    fi

    # Extract EVENT DETAILS block and CONTENT block
    local event_block
    local content_block

    # Read file while stripping possible CR characters to be robust on different platforms
    # Extract blocks by matching headers with optional leading whitespace
    event_block=$(awk '{gsub("\r","") } /^[[:space:]]*\[EVENT DETAILS\]/{found=1; next} found && /^[[:space:]]*\[/{exit} found{print}' "$reqfile")
    content_block=$(awk '{gsub("\r","") } /^[[:space:]]*\[CONTENT\]/{found=1; next} found && /^[[:space:]]*\[/{exit} found{print}' "$reqfile")

    # Fallback subject and details
    EMAIL_SUBJECT="Inquiryon Event Invitation"
    SENDER_EMAIL="${DEFAULT_SENDER_EMAIL}"
    SENDER_NAME="${DEFAULT_SENDER_NAME}"
    HTML_OUTPUT="inquiryon_request_invitation.html"

    # Parse [EMAIL] section if present
    if awk '{gsub("\r","") } /^[[:space:]]*\[EMAIL\]/{print; exit 0}' "$reqfile" >/dev/null 2>&1; then
        # Read lines between [EMAIL] and next [ section (robust to CR and leading whitespace)
        local email_section
        email_section=$(awk '{gsub("\r","") } /^[[:space:]]*\[EMAIL\]/{found=1; next} found && /^[[:space:]]*\[/{exit} found{print}' "$reqfile")
    echo "DEBUG: email_section raw:" 
    echo "$email_section"
        # Extract key: value pairs
    EMAIL_SUBJECT=$(echo "$email_section" | sed -n 's/^[[:space:]]*EMAIL_SUBJECT:[[:space:]]*\(.*\)/\1/p' | head -n1)
    SENDER_EMAIL=$(echo "$email_section" | sed -n 's/^[[:space:]]*SENDER_EMAIL:[[:space:]]*\(.*\)/\1/p' | head -n1)
    SENDER_NAME=$(echo "$email_section" | sed -n 's/^[[:space:]]*SENDER_NAME:[[:space:]]*\(.*\)/\1/p' | head -n1)
    HTML_OUTPUT=$(echo "$email_section" | sed -n 's/^[[:space:]]*HTML_OUTPUT:[[:space:]]*\(.*\)/\1/p' | head -n1)

    # Fallback to existing defaults if empty
    EMAIL_SUBJECT=${EMAIL_SUBJECT:-$EMAIL_SUBJECT}
    SENDER_EMAIL=${SENDER_EMAIL:-$SENDER_EMAIL}
    SENDER_NAME=${SENDER_NAME:-$SENDER_NAME}
    HTML_OUTPUT=${HTML_OUTPUT:-$HTML_OUTPUT}
    fi

    # Parse [RECIPIENTS] section into RECIPIENTS array (use process substitution to avoid subshell)
    RECIPIENTS=()
    if awk '{gsub("\r","") } /^[[:space:]]*\[RECIPIENTS\]/{print; exit 0}' "$reqfile" >/dev/null 2>&1; then
        awk '{gsub("\r","") } /^[[:space:]]*\[RECIPIENTS\]/{flag=1; next} /^[[:space:]]*\[/{flag=0} flag{print}' "$reqfile" | sed 's/^\s*//; s/\s*$//' | grep -v '^#' | while IFS= read -r line; do
            if [[ -n "$line" ]]; then
                RECIPIENTS+=("$line")
            fi
        done
    fi

    # Try to parse common fields from event_block
    if [[ -n "$event_block" ]]; then
        # Simple grep patterns for common fields
        local title
        title=$(echo "$event_block" | sed -n 's/.*Title: \(.*\)/\1/p' | head -n1)
        local date
        date=$(echo "$event_block" | sed -n 's/.*Date: \(.*\)/\1/p' | head -n1)
        local time
        time=$(echo "$event_block" | sed -n 's/.*Time: \(.*\)/\1/p' | head -n1)
        local speaker
        speaker=$(echo "$event_block" | sed -n 's/.*Speaker: \(.*\)/\1/p' | head -n1)
        local venue
        venue=$(echo "$event_block" | sed -n 's/.*Venue: \(.*\)/\1/p' | head -n1)
        local sender
        sender=$(echo "$event_block" | sed -n 's/.*Sender: \(.*\)/\1/p' | head -n1)

        [[ -n "$title" ]] && EMAIL_SUBJECT="$title"
        [[ -n "$sender" ]] && SENDER_NAME="$sender"
        [[ -n "$venue" ]] && VENUE="$venue"
        [[ -n "$date" ]] && EVENT_DATE="$date"
        [[ -n "$time" ]] && EVENT_TIME="$time"
        [[ -n "$speaker" ]] && SPEAKER="$speaker"
    fi

        # Ensure HTML_OUTPUT has a sensible default if parsing didn't set it
        HTML_OUTPUT="${HTML_OUTPUT:-inquiryon_request_invitation.html}"

        # Construct HTML_CONTENT function dynamically by writing a temporary function file and sourcing it
        local tmpf
        tmpf=$(mktemp)

        cat > "$tmpf" <<'BASH'
    HTML_CONTENT() {
    cat <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${EMAIL_SUBJECT}</title>
</head>
<body style="font-family: Arial, sans-serif; background:#f5f7fa; margin:0; padding:20px;">
    <table width="100%"><tr><td align="center">
        <table width="600" style="background:#fff; border-radius:10px; overflow:hidden;">
            <tr><td style="background:linear-gradient(135deg,#667eea,#4c51bf); padding:20px; color:#fff; text-align:center;">
                <img src="https://inquiryon.com/logo.png" height="40" alt="Inquiryon" style="vertical-align:middle;">
                <span style="font-size:20px; font-weight:bold; margin-left:8px;">Inquiryon</span>
            </td></tr>
            <tr><td style="padding:20px; color:#2d3748;">
                <h2 style="margin-top:0;">${EMAIL_SUBJECT}</h2>
                <p style="margin:0 0 10px 0;">Join us for an engaging discussion on AI and safety.</p>
                <table style="width:100%; margin-top:10px;">
                    <tr><td style="vertical-align:top; padding-right:10px; width:30px;">📅</td><td><strong>Date:</strong> ${EVENT_DATE:-TBD}</td></tr>
                    <tr><td style="vertical-align:top; padding-right:10px;">🕒</td><td><strong>Time:</strong> ${EVENT_TIME:-TBD}</td></tr>
                    <tr><td style="vertical-align:top; padding-right:10px;">👤</td><td><strong>Speaker:</strong> ${SPEAKER:-TBD}</td></tr>
                    <tr><td style="vertical-align:top; padding-right:10px;">📍</td><td><strong>Venue:</strong> ${VENUE:-TBD}</td></tr>
                </table>
                <div style="margin-top:15px;">
                    <p style="margin:0;">We will discuss the powerful capabilities of AI agents, MCP and agent tools integration, and our Human-in-the-Loop approach to safe agents. There will be a demo and open discussion.</p>
                </div>
                <div style="margin-top:20px; padding:15px; background:#e6f2ff; border-radius:8px; text-align:center;">
                    <strong>RSVP:</strong> Please reply to this email if you plan to attend. Feel free to forward to interested colleagues.
                </div>
            </td></tr>
            <tr><td style="background:#f7fafc; padding:15px; text-align:center; color:#718096;">
                <strong>Inquiryon Lab</strong> — Developing Safe AI Technologies<br>Contact: <a href="mailto:${SENDER_EMAIL}">${SENDER_EMAIL}</a>
            </td></tr>
        </table>
    </td></tr></table>
</body>
</html>
EOF
}
BASH

        # Source the generated function and remove the temp file
        # shellcheck disable=SC1090
        source "$tmpf"
        rm -f "$tmpf"

        echo "✅ Generated HTML_CONTENT from request file: $reqfile"
}

# Function to load configuration
load_config() {
    local config_file="${1:-$DEFAULT_CONFIG_FILE}"
    
    # If the provided config filename isn't found, check the script directory
    if [[ ! -f "$config_file" ]]; then
        if [[ -f "$SCRIPT_DIR/$config_file" ]]; then
            config_file="$SCRIPT_DIR/$config_file"
        else
            echo "❌ Error: Configuration file '$config_file' not found!"
            exit 1
        fi
    fi

    echo "📋 Loading configuration from: $config_file"

    # Detect if this is a request-style file by checking for [ROLE] or [OBJECTIVE]
    if grep -q "\[ROLE\]\|\[OBJECTIVE\]" "$config_file" 2>/dev/null; then
        echo "🔎 Detected request-style config. Generating HTML template from request."
        generate_from_request "$config_file"
        
    else
        # Assume it's a bash-style config and source it
        source "$config_file"

        # Validate required variables
        if [[ -z "$EMAIL_SUBJECT" ]]; then
            echo "❌ Error: EMAIL_SUBJECT not defined in config file"
            exit 1
        fi

        # Set defaults if not specified
        SENDER_EMAIL="${SENDER_EMAIL:-$DEFAULT_SENDER_EMAIL}"
        SENDER_NAME="${SENDER_NAME:-$DEFAULT_SENDER_NAME}"
        HTML_OUTPUT="${HTML_OUTPUT:-${config_file%.*}.html}"

        echo "✅ Configuration loaded successfully"
        echo "   Subject: $EMAIL_SUBJECT"
        echo "   Recipients: ${#RECIPIENTS[@]:-0} addresses"
        echo "   Output file: $HTML_OUTPUT"
    fi
}

# Function to generate HTML content
generate_html() {
    local output_file="$1"
    
    # Check if HTML_CONTENT function exists
    if ! declare -f HTML_CONTENT > /dev/null; then
        echo "❌ Error: HTML_CONTENT function not defined in config file"
        exit 1
    fi
    
    echo "🔄 Generating HTML content..."
    
    # Call the HTML_CONTENT function and save to file
    HTML_CONTENT > "$output_file"
    
    echo "✅ HTML file generated: $output_file"
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
    echo "To: $SENDER_EMAIL (sender)"
    echo "BCC Recipients: ${#RECIPIENTS[@]} addresses"
    echo
    
    # Show recipient list
    echo "📋 BCC Recipient List:"
    for i in "${!RECIPIENTS[@]}"; do
        echo "  $((i+1)). ${RECIPIENTS[i]}"
    done
    echo
    
    # Confirmation prompt
    read -p "⚠️  Do you want to send this email to all BCC recipients? (y/N): " confirm
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "❌ Email sending cancelled."
        exit 0
    fi
    
    # Read HTML content
    html_content=$(cat "$html_file")
    
    echo "🚀 Sending email with BCC recipients..."
    echo "  📤 To: $SENDER_EMAIL"
    echo "  📤 BCC: ${#RECIPIENTS[@]} recipients (hidden)"
    
    # Send email using Claude MCP Gmail integration
    echo "📡 Calling Gmail MCP service..."
    
    # Create a temporary file for the MCP call
    temp_json=$(mktemp)
    
    # Prepare BCC list
    bcc_json=""
    for i in "${!RECIPIENTS[@]}"; do
        if [[ $i -gt 0 ]]; then
            bcc_json+=","
        fi
        bcc_json+="\"${RECIPIENTS[i]}\""
    done
    
    cat > "$temp_json" << EOF
{
    "to": ["$SENDER_EMAIL"],
    "bcc": [$bcc_json],
    "subject": "$EMAIL_SUBJECT",
    "htmlBody": $(echo "$html_content" | jq -Rs .),
    "mimeType": "text/html"
}
EOF
    
    # Execute the MCP call
    if command -v claude >/dev/null 2>&1; then
        echo "  📄 Sending via Claude MCP..."
        
        # Read the JSON content and send via Claude
        json_content=$(cat "$temp_json")
        if claude "Send email using Gmail MCP with this data: $json_content" 2>$LOG_FILE; then
            echo "  ✅ Email sent successfully!"
        else
            echo "  ❌ Error: MCP call failed. Please check authentication."
            echo "  💡 Make sure you're authenticated with Gmail via Claude MCP"
            echo "  📋 You can manually send with these parameters:"
            echo "      To: $SENDER_EMAIL"
            echo "      BCC: $(IFS=','; echo "${RECIPIENTS[*]}")"
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
    echo "📊 Summary: 1 email sent with ${#RECIPIENTS[@]} BCC recipients"
    echo "🔒 Privacy: Recipient emails are hidden from each other"
}

# Function to validate recipients
validate_recipients() {
    local invalid_emails=()
    
    for email in "${RECIPIENTS[@]}"; do
        if [[ ! "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
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
    
    # Validate required arguments
    if [[ -z "$config_file" ]]; then
        config_file="$DEFAULT_CONFIG_FILE"
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
    
    # Validate recipients if sending email
    if [[ "$send_email_flag" == true ]]; then
        validate_recipients
    fi
    
    # Generate HTML
    if [[ "$generate_only" == true ]]; then
        generate_html "$HTML_OUTPUT"
        echo
        echo "📁 File saved to: $(pwd)/$HTML_OUTPUT"
        echo "🔍 You can now review and edit the HTML file before sending."
        echo
        echo "💡 To send the email later, use:"
        echo "   $0 --config $config_file --send"
        
    elif [[ "$send_email_flag" == true ]]; then
        generate_html "$HTML_OUTPUT"
        echo
        send_email "$HTML_OUTPUT"
        
    else
        # Default: generate and ask what to do next
        generate_html "$HTML_OUTPUT"
        echo
        echo "📁 HTML file generated: $HTML_OUTPUT"
        echo
        echo "What would you like to do next?"
        echo "1. Generate & review the HTML file"
        echo "2. Send email to recipients"
        echo "3. Exit"
        echo
        read -p "Enter your choice (1-3): " choice
        
        case $choice in
            1)
                if command -v open >/dev/null 2>&1; then
                    open "$HTML_OUTPUT"
                elif command -v xdg-open >/dev/null 2>&1; then
                    xdg-open "$HTML_OUTPUT"
                else
                    echo "📄 Please open $HTML_OUTPUT in your browser to review."
                fi
                ;;
            2)
                validate_recipients
                send_email "$HTML_OUTPUT"
                ;;
            3)
                echo "👋 Goodbye!"
                exit 0
                ;;
            *)
                echo "❌ Invalid choice. Exiting."
                exit 1
                ;;
        esac
    fi
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi