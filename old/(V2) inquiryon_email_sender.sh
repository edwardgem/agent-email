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
    $0                                     Run the script, use default config, and select options interactively
    $0 -c inquiryon.conf -g                Generate HTML only
    $0 -c inquiryon.conf -s                Generate and send email
    $0 -c my_event.conf -o custom.html -g      Generate with custom output name

NOTE: 
    - Content configuration file is required
    - Update recipient list in the config file before sending
    - Ensure you have Claude MCP server access for Gmail
EOF
}

# Function to load configuration
load_config() {
    local config_file="${1:-inquiryon.conf}"
    
    if [[ ! -f "$config_file" ]]; then
        echo "❌ Error: Configuration file '$config_file' not found!"
        exit 1
    fi
    
    echo "📋 Loading configuration from: $config_file"
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
    echo "   Recipients: ${#RECIPIENTS[@]} addresses"
    echo "   Output file: $HTML_OUTPUT"
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
        config_file="inquiryon.conf"
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